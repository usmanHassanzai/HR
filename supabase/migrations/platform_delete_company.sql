-- Permanently delete a company and all of its users, attendance, KPIs, shifts, and history.

ALTER TABLE public.employee_shift_assignments
    ALTER COLUMN assigned_by DROP NOT NULL;

ALTER TABLE public.employee_shift_assignments
    DROP CONSTRAINT IF EXISTS employee_shift_assignments_assigned_by_fkey;

ALTER TABLE public.employee_shift_assignments
    ADD CONSTRAINT employee_shift_assignments_assigned_by_fkey
    FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;

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

        -- Extra history tables keyed by user_id (in case some FKs are missing)
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

    FOR rec IN
        SELECT u.id FROM public.users u
        WHERE u.id = ANY(v_ids)
    LOOP
        DELETE FROM auth.users WHERE id = rec.id;
    END LOOP;

    DELETE FROM public.users
    WHERE company_id = p_company_id
      AND is_demo = false
      AND is_platform_owner = false;

    DELETE FROM public.companies WHERE id = p_company_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Ensure platform owner sees every registered company (all statuses, no demo filter)
CREATE OR REPLACE FUNCTION public.platform_get_companies()
RETURNS TABLE(
    id UUID,
    name TEXT,
    slug TEXT,
    status public.company_status,
    contact_email TEXT,
    contact_name TEXT,
    contact_phone TEXT,
    job_title TEXT,
    industry TEXT,
    employee_count TEXT,
    website TEXT,
    address_line TEXT,
    city TEXT,
    country TEXT,
    subscription_plan public.subscription_plan,
    registration_notes TEXT,
    owner_email TEXT,
    owner_name TEXT,
    created_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    user_count BIGINT
) AS $$
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: platform owner only';
    END IF;

    RETURN QUERY
        SELECT
            c.id, c.name, c.slug, c.status, c.contact_email, c.contact_name,
            c.contact_phone, c.job_title, c.industry, c.employee_count, c.website,
            c.address_line, c.city, c.country, c.subscription_plan, c.registration_notes,
            u.email, u.full_name, c.created_at, c.approved_at,
            (SELECT COUNT(*) FROM public.users u2 WHERE u2.company_id = c.id AND u2.is_demo = false)
        FROM public.companies c
        LEFT JOIN public.users u ON u.id = c.owner_user_id
        ORDER BY c.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.platform_delete_company(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_get_companies() TO authenticated;
