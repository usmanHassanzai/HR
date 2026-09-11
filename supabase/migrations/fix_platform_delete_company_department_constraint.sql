-- Fix platform company delete: deleting departments first SET NULLs users.department_id
-- and trips users_employee_manager_need_department. Delete users before departments.

CREATE OR REPLACE FUNCTION public.platform_delete_company(p_company_id UUID)
RETURNS VOID AS $$
DECLARE
    rec RECORD;
    v_ids UUID[];
    v_fk RECORD;
    v_col RECORD;
    v_hist TEXT;
    v_sql TEXT;
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: platform owner only';
    END IF;

    IF p_company_id IS NULL THEN
        RAISE EXCEPTION 'Company id is required';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id) THEN
        RAISE EXCEPTION 'Company not found';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.companies c
        WHERE c.id = p_company_id
          AND (
            c.slug = 'walfia-default'
            OR lower(trim(c.name)) IN ('walfia', 'walfia default')
          )
    ) THEN
        RAISE EXCEPTION 'The Walfia default organization cannot be deleted';
    END IF;

    SELECT COALESCE(array_agg(u.id), ARRAY[]::UUID[])
    INTO v_ids
    FROM public.users u
    WHERE u.company_id = p_company_id
      AND u.is_demo = false
      AND u.is_platform_owner = false;

    UPDATE public.companies
    SET owner_user_id = NULL,
        approved_by = NULL
    WHERE id = p_company_id;

    IF cardinality(v_ids) > 0 THEN
        UPDATE public.users SET manager_id = NULL WHERE id = ANY(v_ids);

        -- Break non-cascade FKs pointing at these users (assigned_by, marked_by, etc.)
        FOR v_fk IN
            SELECT
                src.relname AS table_name,
                att.attname AS column_name,
                rc.confdeltype
            FROM pg_constraint rc
            JOIN pg_class src ON src.oid = rc.conrelid
            JOIN pg_namespace nsp ON nsp.oid = src.relnamespace AND nsp.nspname = 'public'
            JOIN pg_class tgt ON tgt.oid = rc.confrelid
            JOIN pg_attribute att ON att.attrelid = rc.conrelid AND att.attnum = rc.conkey[1]
            WHERE rc.contype = 'f'
              AND tgt.relname = 'users'
              AND src.relname <> 'users'
        LOOP
            IF v_fk.confdeltype = 'c' THEN
                CONTINUE; -- ON DELETE CASCADE
            ELSIF v_fk.confdeltype = 'n' THEN
                v_sql := format('UPDATE public.%I SET %I = NULL WHERE %I = ANY($1)',
                    v_fk.table_name, v_fk.column_name, v_fk.column_name);
                EXECUTE v_sql USING v_ids;
            ELSE
                v_sql := format('DELETE FROM public.%I WHERE %I = ANY($1)',
                    v_fk.table_name, v_fk.column_name);
                EXECUTE v_sql USING v_ids;
            END IF;
        END LOOP;

        FOREACH v_hist IN ARRAY ARRAY[
            'attendance_visit_segments',
            'attendance_records',
            'leave_requests',
            'leave_balances',
            'daily_work_reports',
            'employee_shift_assignments',
            'kpis',
            'kpi_submissions',
            'tasks',
            'notifications',
            'rewards_redemptions',
            'employee_location_pings',
            'employee_office_assignments'
        ]::TEXT[]
        LOOP
            IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = v_hist
            ) THEN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = v_hist AND column_name = 'user_id'
                ) THEN
                    EXECUTE format('DELETE FROM public.%I WHERE user_id = ANY($1)', v_hist) USING v_ids;
                END IF;
            END IF;
        END LOOP;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'work_shifts') THEN
            DELETE FROM public.work_shifts WHERE manager_id = ANY(v_ids);
        END IF;

        -- Users must go before departments: departments FK is ON DELETE SET NULL on
        -- users.department_id, which violates users_employee_manager_need_department.
        FOR rec IN
            SELECT u.id FROM public.users u
            WHERE u.id = ANY(v_ids)
        LOOP
            DELETE FROM auth.users WHERE id = rec.id;
        END LOOP;

        DELETE FROM public.users
        WHERE id = ANY(v_ids);
    END IF;

    -- Company-scoped tables (attendance reports, offices, departments, KPIs library, etc.)
    FOR v_col IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public'
          AND c.column_name = 'company_id'
          AND c.table_name NOT IN ('users', 'companies')
    LOOP
        EXECUTE format('DELETE FROM public.%I WHERE company_id = $1', v_col.table_name) USING p_company_id;
    END LOOP;

    -- Catch any remaining non-demo company users
    DELETE FROM public.users
    WHERE company_id = p_company_id
      AND is_demo = false
      AND is_platform_owner = false;

    DELETE FROM public.companies WHERE id = p_company_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.platform_delete_company(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
