-- HR role: company-wide shift create/edit/assign without becoming Admin.
-- Permission is role-based (user_role = 'hr'), not a named account.
-- Requires hr_role_enum.sql to have been committed first.

CREATE OR REPLACE FUNCTION public.is_hr(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_uid AND u.role::text = 'hr'
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_org_shifts(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin(p_uid) OR public.is_hr(p_uid);
$$;

GRANT EXECUTE ON FUNCTION public.is_hr(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_org_shifts(UUID) TO authenticated;

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
    v_role_txt TEXT;
    v_id UUID;
    v_demo BOOLEAN;
    v_overnight BOOLEAN;
    v_company UUID;
    v_org BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role::text INTO v_role_txt FROM public.users WHERE id = v_uid;
    IF v_role_txt NOT IN ('manager', 'admin', 'hr') THEN
        RAISE EXCEPTION 'Only managers, HR, and admins can manage shifts';
    END IF;

    v_org := public.can_manage_org_shifts(v_uid);
    v_overnight := COALESCE(p_crosses_midnight, public.is_shift_overnight(p_start_time, p_end_time));

    IF NOT v_overnight AND p_end_time <= p_start_time THEN
        RAISE EXCEPTION 'End time must be after start time (or enable overnight shift)';
    END IF;

    v_demo := public.is_demo_user(v_uid);
    PERFORM public.enforce_demo_isolation(v_uid);

    IF v_org AND NOT v_demo THEN
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
                  v_org
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

    IF p_apply_to_all AND v_role_txt = 'manager' THEN
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
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    IF public.can_manage_org_shifts(v_uid) THEN
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

CREATE OR REPLACE FUNCTION public.admin_assign_shift(
    p_shift_id UUID,
    p_user_ids UUID[],
    p_effective_from DATE DEFAULT CURRENT_DATE
)
RETURNS INTEGER AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role_txt TEXT;
    v_company UUID;
    v_count INTEGER := 0;
    v_target UUID;
    v_shift public.work_shifts%ROWTYPE;
    v_org BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_ids IS NULL OR cardinality(p_user_ids) = 0 THEN
        RAISE EXCEPTION 'Select at least one person';
    END IF;

    SELECT role::text INTO v_role_txt FROM public.users WHERE id = v_uid;
    IF v_role_txt NOT IN ('admin', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Only admins, HR, and managers can assign shifts';
    END IF;

    v_org := public.can_manage_org_shifts(v_uid);

    SELECT * INTO v_shift FROM public.work_shifts WHERE id = p_shift_id AND active = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found'; END IF;

    PERFORM public.enforce_demo_isolation(v_uid);

    IF v_org THEN
        IF public.is_demo_user(v_uid) THEN
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
        IF v_org THEN
            IF public.is_demo_user(v_uid) THEN
                IF NOT EXISTS (
                    SELECT 1 FROM public.users u
                    WHERE u.id = v_target
                      AND u.is_demo = true
                      AND u.role::text IN ('employee', 'manager', 'hr')
                ) THEN
                    CONTINUE;
                END IF;
            ELSE
                IF NOT EXISTS (
                    SELECT 1 FROM public.users u
                    WHERE u.id = v_target
                      AND u.company_id = v_company
                      AND u.is_demo = false
                      AND u.role::text IN ('employee', 'manager', 'hr')
                ) THEN
                    CONTINUE;
                END IF;
            END IF;
        ELSE
            IF NOT EXISTS (
                SELECT 1 FROM public.users u
                WHERE u.id = v_target
                  AND u.manager_id = v_uid
                  AND u.role::text = 'employee'
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
    v_role_txt TEXT;
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT u.role::text INTO v_role_txt FROM public.users u WHERE u.id = v_uid;
    IF v_role_txt NOT IN ('manager', 'admin', 'hr') THEN
        RAISE EXCEPTION 'Managers, HR, and admins only';
    END IF;

    IF public.can_manage_org_shifts(v_uid) AND NOT public.is_demo_user(v_uid) THEN
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

    IF public.can_manage_org_shifts(v_uid) AND public.is_demo_user(v_uid) THEN
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
    IF NOT public.can_manage_org_shifts(v_uid) THEN
        RAISE EXCEPTION 'Only admins and HR can view organization shift assignments';
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
          AND u.role::text IN ('employee', 'manager', 'hr')
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
      AND u.role::text IN ('employee', 'manager', 'hr')
    ORDER BY u.role DESC, u.full_name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_all_users_admin()
RETURNS SETOF public.users AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_uid) AND NOT public.is_hr(v_uid) THEN
        RAISE EXCEPTION 'Only admins and HR can list all users';
    END IF;

    IF public.is_demo_user(v_uid) THEN
        RETURN QUERY
        SELECT u.* FROM public.users u
        WHERE u.is_demo = true
        ORDER BY u.full_name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'Your account is not linked to a company';
    END IF;

    RETURN QUERY
    SELECT u.* FROM public.users u
    WHERE u.company_id = v_company
      AND u.is_demo = false
      AND u.is_platform_owner = false
    ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.admin_update_user_account(
    p_user_id UUID,
    p_full_name TEXT,
    p_role TEXT,
    p_department_id UUID DEFAULT NULL,
    p_manager_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_target public.users%ROWTYPE;
    v_role public.user_role;
    v_needs_dept BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only company admin can edit user accounts';
    END IF;

    IF trim(coalesce(p_full_name, '')) = '' THEN
        RAISE EXCEPTION 'Full name is required';
    END IF;

    IF p_role NOT IN ('employee', 'manager', 'admin', 'hr') THEN
        RAISE EXCEPTION 'Invalid role';
    END IF;
    v_role := p_role::public.user_role;
    v_needs_dept := p_role IN ('employee', 'manager');

    v_company := public.current_company_id();

    SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    IF v_company IS NOT NULL AND v_target.company_id IS DISTINCT FROM v_company THEN
        RAISE EXCEPTION 'User is not in your company';
    END IF;

    IF p_user_id = v_uid AND p_role <> 'admin' THEN
        RAISE EXCEPTION 'You cannot remove your own admin role';
    END IF;

    IF v_needs_dept AND p_department_id IS NULL THEN
        RAISE EXCEPTION 'Department is required for managers and employees';
    END IF;

    IF p_manager_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.users m
            WHERE m.id = p_manager_id
              AND m.role::text IN ('manager', 'admin')
              AND (v_company IS NULL OR m.company_id = v_company)
        ) THEN
            RAISE EXCEPTION 'Selected manager/admin is invalid';
        END IF;
    END IF;

    UPDATE public.users u
    SET
        full_name = trim(p_full_name),
        role = v_role,
        department_id = CASE WHEN v_needs_dept THEN p_department_id ELSE NULL END,
        manager_id = CASE WHEN v_needs_dept THEN p_manager_id ELSE NULL END
    WHERE u.id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS work_shifts_write ON public.work_shifts;
DROP POLICY IF EXISTS work_shifts_update ON public.work_shifts;
DROP POLICY IF EXISTS work_shifts_delete ON public.work_shifts;
DROP POLICY IF EXISTS employee_shift_assignments_select ON public.employee_shift_assignments;
DROP POLICY IF EXISTS employee_shift_assignments_insert ON public.employee_shift_assignments;
DROP POLICY IF EXISTS employee_shift_assignments_update ON public.employee_shift_assignments;
DROP POLICY IF EXISTS employee_shift_assignments_delete ON public.employee_shift_assignments;

CREATE POLICY work_shifts_write ON public.work_shifts
  FOR INSERT TO authenticated
  WITH CHECK (
    manager_id = auth.uid()
    OR (public.can_manage_org_shifts(auth.uid()) AND public.same_company(manager_id))
  );

CREATE POLICY work_shifts_update ON public.work_shifts
  FOR UPDATE TO authenticated
  USING (
    manager_id = auth.uid()
    OR (public.can_manage_org_shifts(auth.uid()) AND public.same_company(manager_id))
  )
  WITH CHECK (
    manager_id = auth.uid()
    OR (public.can_manage_org_shifts(auth.uid()) AND public.same_company(manager_id))
  );

CREATE POLICY work_shifts_delete ON public.work_shifts
  FOR DELETE TO authenticated
  USING (
    manager_id = auth.uid()
    OR (public.can_manage_org_shifts(auth.uid()) AND public.same_company(manager_id))
  );

CREATE POLICY employee_shift_assignments_select ON public.employee_shift_assignments
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.can_access_user_data(user_id)
    OR (public.can_manage_org_shifts(auth.uid()) AND public.same_company(user_id))
  );

CREATE POLICY employee_shift_assignments_insert ON public.employee_shift_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_manage_org_shifts(auth.uid()) OR public.is_manager_of(auth.uid(), user_id)
  );

CREATE POLICY employee_shift_assignments_update ON public.employee_shift_assignments
  FOR UPDATE TO authenticated
  USING (
    public.can_manage_org_shifts(auth.uid()) OR public.is_manager_of(auth.uid(), user_id)
  )
  WITH CHECK (
    public.can_manage_org_shifts(auth.uid()) OR public.is_manager_of(auth.uid(), user_id)
  );

CREATE POLICY employee_shift_assignments_delete ON public.employee_shift_assignments
  FOR DELETE TO authenticated
  USING (
    public.can_manage_org_shifts(auth.uid()) OR public.is_manager_of(auth.uid(), user_id)
  );

-- Promote existing company "Samiya Kayani" manager accounts to HR.
-- Never demote admins or platform owners.
UPDATE public.users
SET role = 'hr'::public.user_role
WHERE COALESCE(is_platform_owner, false) = false
  AND role::text = 'manager'
  AND lower(trim(full_name)) = 'samiya kayani';

GRANT EXECUTE ON FUNCTION public.upsert_work_shift(TEXT, TIME, TIME, INTEGER[], INTEGER, UUID, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_work_shift(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_shift(UUID, UUID[], DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_manager_shifts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_shift_assignments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_users_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_user_account(UUID, TEXT, TEXT, UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
