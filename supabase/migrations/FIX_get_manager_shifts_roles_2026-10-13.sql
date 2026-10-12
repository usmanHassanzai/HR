-- Restore get_manager_shifts for Admin / HR / Manager.
-- Live had drift back to shift_attendance_v2_fix ("Managers only", no HR, no company scope).
-- Also restore delete_work_shift org delete, and drop stale 8-arg upsert overload.

DROP FUNCTION IF EXISTS public.get_manager_shifts();

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
    assigned_count BIGINT,
    timezone TEXT
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
            ) AS assigned_count,
            NULLIF(btrim(ws.timezone), '')
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
            ) AS assigned_count,
            NULLIF(btrim(ws.timezone), '')
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
        ) AS assigned_count,
        NULLIF(btrim(ws.timezone), '')
    FROM public.work_shifts ws
    WHERE ws.manager_id = v_uid
    ORDER BY ws.start_time;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_manager_shifts() TO authenticated;

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

GRANT EXECUTE ON FUNCTION public.delete_work_shift(UUID) TO authenticated;

-- Stale overload left by re-applying early migrations after the timezone/zones signature existed.
DROP FUNCTION IF EXISTS public.upsert_work_shift(TEXT, TIME, TIME, INTEGER[], INTEGER, UUID, BOOLEAN, BOOLEAN);

NOTIFY pgrst, 'reload schema';
