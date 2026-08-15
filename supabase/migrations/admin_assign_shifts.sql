-- Admin can create shifts and assign them directly to managers and employees
-- (same company only). Managers keep existing team-only behavior.

CREATE OR REPLACE FUNCTION public.upsert_work_shift(
    p_name TEXT,
    p_start_time TIME,
    p_end_time TIME,
    p_days_of_week INTEGER[] DEFAULT ARRAY[1,2,3,4,5],
    p_grace_minutes INTEGER DEFAULT 30,
    p_shift_id UUID DEFAULT NULL,
    p_crosses_midnight BOOLEAN DEFAULT NULL,
    p_apply_to_all BOOLEAN DEFAULT true
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
    v_id UUID;
    v_demo BOOLEAN;
    v_overnight BOOLEAN;
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role INTO v_role FROM public.users WHERE id = v_uid;
    IF v_role NOT IN ('manager'::public.user_role, 'admin'::public.user_role) THEN
        RAISE EXCEPTION 'Only managers and admins can manage shifts';
    END IF;

    v_overnight := COALESCE(p_crosses_midnight, public.is_shift_overnight(p_start_time, p_end_time));

    IF NOT v_overnight AND p_end_time <= p_start_time THEN
        RAISE EXCEPTION 'End time must be after start time (or enable overnight shift)';
    END IF;

    v_demo := public.is_demo_user(v_uid);
    PERFORM public.enforce_demo_isolation(v_uid);

    IF v_role = 'admin'::public.user_role AND NOT v_demo THEN
        v_company := public.current_company_id();
        IF v_company IS NULL THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
    END IF;

    IF p_shift_id IS NULL THEN
        INSERT INTO public.work_shifts (
            manager_id, name, start_time, end_time, days_of_week, grace_minutes,
            crosses_midnight, apply_to_all, is_demo
        ) VALUES (
            v_uid, trim(p_name), p_start_time, p_end_time, p_days_of_week, p_grace_minutes,
            v_overnight, p_apply_to_all, v_demo
        )
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.work_shifts ws SET
            name = trim(p_name),
            start_time = p_start_time,
            end_time = p_end_time,
            days_of_week = p_days_of_week,
            grace_minutes = p_grace_minutes,
            crosses_midnight = v_overnight,
            apply_to_all = p_apply_to_all,
            updated_at = timezone('utc'::text, now())
        WHERE ws.id = p_shift_id
          AND (
              ws.manager_id = v_uid
              OR (
                  v_role = 'admin'::public.user_role
                  AND EXISTS (
                      SELECT 1 FROM public.users owner
                      WHERE owner.id = ws.manager_id
                        AND (
                            (v_demo AND owner.is_demo = true)
                            OR (NOT v_demo AND owner.company_id = v_company)
                        )
                  )
              )
          )
        RETURNING ws.id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
    END IF;

    -- Managers: auto-apply to their employees when requested
    IF p_apply_to_all AND v_role = 'manager'::public.user_role THEN
        BEGIN
            PERFORM public.assign_shift_to_all_team(v_id, CURRENT_DATE);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.delete_work_shift(p_shift_id UUID)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role INTO v_role FROM public.users WHERE id = v_uid;

    IF v_role = 'admin'::public.user_role THEN
        IF public.is_demo_user(v_uid) THEN
            DELETE FROM public.work_shifts ws
            WHERE ws.id = p_shift_id
              AND EXISTS (SELECT 1 FROM public.users o WHERE o.id = ws.manager_id AND o.is_demo = true);
        ELSE
            v_company := public.current_company_id();
            DELETE FROM public.work_shifts ws
            WHERE ws.id = p_shift_id
              AND EXISTS (
                  SELECT 1 FROM public.users o
                  WHERE o.id = ws.manager_id AND o.company_id = v_company
              );
        END IF;
    ELSE
        DELETE FROM public.work_shifts WHERE id = p_shift_id AND manager_id = v_uid;
    END IF;

    IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Assign one shift to many managers and/or employees (admin), or team employees (manager)
CREATE OR REPLACE FUNCTION public.admin_assign_shift(
    p_shift_id UUID,
    p_user_ids UUID[],
    p_effective_from DATE DEFAULT CURRENT_DATE
)
RETURNS INTEGER AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
    v_company UUID;
    v_count INTEGER := 0;
    v_target UUID;
    v_shift public.work_shifts%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_ids IS NULL OR cardinality(p_user_ids) = 0 THEN
        RAISE EXCEPTION 'Select at least one person';
    END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_uid;
    IF v_role NOT IN ('admin'::public.user_role, 'manager'::public.user_role) THEN
        RAISE EXCEPTION 'Only admins and managers can assign shifts';
    END IF;

    SELECT * INTO v_shift FROM public.work_shifts WHERE id = p_shift_id AND active = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found'; END IF;

    PERFORM public.enforce_demo_isolation(v_uid);

    IF v_role = 'admin'::public.user_role THEN
        IF public.is_demo_user(v_uid) THEN
            -- demo: any demo manager/employee
            NULL;
        ELSE
            v_company := public.current_company_id();
            IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;
            IF NOT EXISTS (
                SELECT 1 FROM public.users o
                WHERE o.id = v_shift.manager_id AND o.company_id = v_company
            ) AND v_shift.manager_id <> v_uid THEN
                RAISE EXCEPTION 'Shift is not in your organization';
            END IF;
        END IF;
    ELSE
        IF v_shift.manager_id <> v_uid THEN
            RAISE EXCEPTION 'You can only assign your own shifts';
        END IF;
    END IF;

    FOREACH v_target IN ARRAY p_user_ids
    LOOP
        IF v_role = 'admin'::public.user_role THEN
            IF public.is_demo_user(v_uid) THEN
                IF NOT EXISTS (
                    SELECT 1 FROM public.users u
                    WHERE u.id = v_target
                      AND u.is_demo = true
                      AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
                ) THEN
                    CONTINUE;
                END IF;
            ELSE
                IF NOT EXISTS (
                    SELECT 1 FROM public.users u
                    WHERE u.id = v_target
                      AND u.company_id = v_company
                      AND u.is_demo = false
                      AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
                ) THEN
                    CONTINUE;
                END IF;
            END IF;
        ELSE
            IF NOT EXISTS (
                SELECT 1 FROM public.users u
                WHERE u.id = v_target
                  AND u.manager_id = v_uid
                  AND u.role = 'employee'::public.user_role
            ) THEN
                CONTINUE;
            END IF;
        END IF;

        UPDATE public.employee_shift_assignments
        SET effective_to = p_effective_from - 1
        WHERE user_id = v_target
          AND effective_to IS NULL
          AND shift_id IS DISTINCT FROM p_shift_id;

        IF NOT EXISTS (
            SELECT 1 FROM public.employee_shift_assignments
            WHERE user_id = v_target AND shift_id = p_shift_id AND effective_to IS NULL
        ) THEN
            INSERT INTO public.employee_shift_assignments (user_id, shift_id, assigned_by, effective_from, is_demo)
            VALUES (v_target, p_shift_id, v_uid, p_effective_from, public.is_demo_user(v_uid));
        END IF;

        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_manager_shifts()
RETURNS TABLE(
    id UUID,
    name TEXT,
    start_time TIME,
    end_time TIME,
    days_of_week INTEGER[],
    grace_minutes INTEGER,
    active BOOLEAN,
    crosses_midnight BOOLEAN,
    apply_to_all BOOLEAN,
    assigned_count BIGINT
) AS $$
#variable_conflict use_column
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;
    IF v_role NOT IN ('manager'::public.user_role, 'admin'::public.user_role) THEN
        RAISE EXCEPTION 'Managers only';
    END IF;

    IF v_role = 'admin'::public.user_role AND NOT public.is_demo_user(v_uid) THEN
        v_company := public.current_company_id();
        IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

        RETURN QUERY
        SELECT
            ws.id, ws.name, ws.start_time, ws.end_time, ws.days_of_week, ws.grace_minutes,
            ws.active, ws.crosses_midnight, ws.apply_to_all,
            (
                SELECT COUNT(*)::BIGINT
                FROM public.employee_shift_assignments esa
                WHERE esa.shift_id = ws.id AND esa.effective_to IS NULL
            ) AS assigned_count
        FROM public.work_shifts ws
        JOIN public.users owner ON owner.id = ws.manager_id
        WHERE owner.company_id = v_company
           OR ws.manager_id = v_uid
        ORDER BY ws.start_time;
        RETURN;
    END IF;

    IF v_role = 'admin'::public.user_role AND public.is_demo_user(v_uid) THEN
        RETURN QUERY
        SELECT
            ws.id, ws.name, ws.start_time, ws.end_time, ws.days_of_week, ws.grace_minutes,
            ws.active, ws.crosses_midnight, ws.apply_to_all,
            (
                SELECT COUNT(*)::BIGINT
                FROM public.employee_shift_assignments esa
                WHERE esa.shift_id = ws.id AND esa.effective_to IS NULL
            ) AS assigned_count
        FROM public.work_shifts ws
        WHERE ws.is_demo = true
        ORDER BY ws.start_time;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        ws.id, ws.name, ws.start_time, ws.end_time, ws.days_of_week, ws.grace_minutes,
        ws.active, ws.crosses_midnight, ws.apply_to_all,
        (
            SELECT COUNT(*)::BIGINT
            FROM public.employee_shift_assignments esa
            WHERE esa.shift_id = ws.id AND esa.effective_to IS NULL
        ) AS assigned_count
    FROM public.work_shifts ws
    WHERE ws.manager_id = v_uid
    ORDER BY ws.start_time;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Org-wide shift status for admins (managers + employees)
CREATE OR REPLACE FUNCTION public.get_org_shift_assignments()
RETURNS TABLE(
    user_id UUID,
    full_name TEXT,
    email TEXT,
    employee_role TEXT,
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    effective_from DATE
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only admins can view organization shift assignments';
    END IF;

    IF public.is_demo_user(v_uid) THEN
        RETURN QUERY
        SELECT
            u.id, u.full_name, u.email, u.role::TEXT,
            esa.shift_id, ws.name, ws.start_time, ws.end_time, esa.effective_from
        FROM public.users u
        LEFT JOIN LATERAL (
            SELECT esa2.shift_id, esa2.effective_from
            FROM public.employee_shift_assignments esa2
            WHERE esa2.user_id = u.id
              AND esa2.effective_from <= CURRENT_DATE
              AND (esa2.effective_to IS NULL OR esa2.effective_to >= CURRENT_DATE)
            ORDER BY esa2.effective_from DESC
            LIMIT 1
        ) esa ON true
        LEFT JOIN public.work_shifts ws ON ws.id = esa.shift_id AND ws.active = true
        WHERE u.is_demo = true
          AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
        ORDER BY u.role DESC, u.full_name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

    RETURN QUERY
    SELECT
        u.id, u.full_name, u.email, u.role::TEXT,
        esa.shift_id, ws.name, ws.start_time, ws.end_time, esa.effective_from
    FROM public.users u
    LEFT JOIN LATERAL (
        SELECT esa2.shift_id, esa2.effective_from
        FROM public.employee_shift_assignments esa2
        WHERE esa2.user_id = u.id
          AND esa2.effective_from <= CURRENT_DATE
          AND (esa2.effective_to IS NULL OR esa2.effective_to >= CURRENT_DATE)
        ORDER BY esa2.effective_from DESC
        LIMIT 1
    ) esa ON true
    LEFT JOIN public.work_shifts ws ON ws.id = esa.shift_id AND ws.active = true
    WHERE u.company_id = v_company
      AND u.is_demo = false
      AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
    ORDER BY u.role DESC, u.full_name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.upsert_work_shift(TEXT, TIME, TIME, INTEGER[], INTEGER, UUID, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_work_shift(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_shift(UUID, UUID[], DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_manager_shifts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_shift_assignments() TO authenticated;

NOTIFY pgrst, 'reload schema';
