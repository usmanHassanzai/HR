-- Self-serve account deletion (App Store / Play Store compliance).
-- Password is verified in the delete_account edge function; this RPC performs the wipe.

CREATE OR REPLACE FUNCTION public.account_deletion_info()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_user public.users%ROWTYPE;
    v_company public.companies%ROWTYPE;
    v_members INT := 0;
    v_is_owner BOOLEAN := false;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not signed in';
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found';
    END IF;

    IF v_user.company_id IS NOT NULL THEN
        SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;
        IF FOUND THEN
            v_is_owner := (v_company.owner_user_id IS NOT DISTINCT FROM v_uid);
            SELECT COUNT(*)::INT INTO v_members
            FROM public.users u
            WHERE u.company_id = v_user.company_id
              AND COALESCE(u.is_demo, false) = false
              AND COALESCE(u.is_platform_owner, false) = false;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'user_id', v_uid,
        'email', v_user.email,
        'full_name', v_user.full_name,
        'role', v_user.role,
        'is_demo', COALESCE(v_user.is_demo, false),
        'is_platform_owner', COALESCE(v_user.is_platform_owner, false),
        'company_id', v_user.company_id,
        'company_name', v_company.name,
        'company_slug', v_company.slug,
        'is_company_owner', v_is_owner,
        'member_count', v_members,
        'other_members', GREATEST(v_members - 1, 0),
        'is_walfia_default', (
            COALESCE(v_company.slug, '') = 'walfia-default'
            OR lower(trim(COALESCE(v_company.name, ''))) IN ('walfia', 'walfia default')
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.account_deletion_info() TO authenticated;

-- Wipe a company the caller owns (or empty company when sole member).
-- Internal helper — not granted to authenticated (called only from delete_own_account).
CREATE OR REPLACE FUNCTION public._wipe_company_for_owner(p_company_id UUID, p_caller UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    rec RECORD;
    v_ids UUID[];
    v_fk RECORD;
    v_col RECORD;
    v_hist TEXT;
    v_sql TEXT;
BEGIN
    IF p_company_id IS NULL OR p_caller IS NULL THEN
        RAISE EXCEPTION 'Company id and caller are required';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.companies c
        WHERE c.id = p_company_id
          AND c.owner_user_id IS NOT DISTINCT FROM p_caller
    ) THEN
        RAISE EXCEPTION 'Only the company owner can delete the organization';
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
      AND COALESCE(u.is_demo, false) = false
      AND COALESCE(u.is_platform_owner, false) = false;

    UPDATE public.companies
    SET owner_user_id = NULL,
        approved_by = NULL
    WHERE id = p_company_id;

    IF cardinality(v_ids) > 0 THEN
        UPDATE public.users SET manager_id = NULL WHERE id = ANY(v_ids);

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
                CONTINUE;
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

        FOR rec IN
            SELECT u.id FROM public.users u WHERE u.id = ANY(v_ids)
        LOOP
            DELETE FROM auth.users WHERE id = rec.id;
        END LOOP;

        DELETE FROM public.users WHERE id = ANY(v_ids);
    END IF;

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

    DELETE FROM public.users
    WHERE company_id = p_company_id
      AND COALESCE(is_demo, false) = false
      AND COALESCE(is_platform_owner, false) = false;

    DELETE FROM public.companies WHERE id = p_company_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_own_account(p_delete_company BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_user public.users%ROWTYPE;
    v_company public.companies%ROWTYPE;
    v_is_owner BOOLEAN := false;
    v_other INT := 0;
    v_fk RECORD;
    v_sql TEXT;
    v_ids UUID[];
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not signed in';
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found';
    END IF;

    IF COALESCE(v_user.is_platform_owner, false) THEN
        RAISE EXCEPTION 'Platform owner accounts cannot be self-deleted. Contact support.';
    END IF;

    IF COALESCE(v_user.is_demo, false) THEN
        RAISE EXCEPTION 'Demo sandbox accounts cannot be deleted from Settings.';
    END IF;

    IF v_user.company_id IS NOT NULL THEN
        SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;
        IF FOUND THEN
            v_is_owner := (v_company.owner_user_id IS NOT DISTINCT FROM v_uid);
            SELECT COUNT(*)::INT INTO v_other
            FROM public.users u
            WHERE u.company_id = v_user.company_id
              AND u.id <> v_uid
              AND COALESCE(u.is_demo, false) = false
              AND COALESCE(u.is_platform_owner, false) = false;
        END IF;
    END IF;

    -- Company owner with other members: must explicitly wipe the whole org
    -- (or transfer ownership outside this flow first).
    IF v_is_owner AND v_other > 0 AND NOT COALESCE(p_delete_company, false) THEN
        RAISE EXCEPTION
            'You own "%" which still has % other member(s). Transfer ownership to another admin, or confirm deleting the entire company and all employee data.',
            COALESCE(v_company.name, 'your company'),
            v_other;
    END IF;

    IF v_is_owner AND COALESCE(p_delete_company, false) THEN
        PERFORM public._wipe_company_for_owner(v_user.company_id, v_uid);
        RETURN jsonb_build_object('ok', true, 'deleted_company', true);
    END IF;

    -- Sole owner (no other members): remove empty company with the account
    IF v_is_owner AND v_other = 0 AND v_user.company_id IS NOT NULL THEN
        PERFORM public._wipe_company_for_owner(v_user.company_id, v_uid);
        RETURN jsonb_build_object('ok', true, 'deleted_company', true);
    END IF;

    -- Non-owner (or owner already wiped above): delete only this user
    v_ids := ARRAY[v_uid];

    UPDATE public.companies
    SET owner_user_id = NULL
    WHERE owner_user_id = v_uid;

    UPDATE public.users SET manager_id = NULL WHERE manager_id = v_uid;

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
            CONTINUE;
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

    DELETE FROM auth.users WHERE id = v_uid;
    DELETE FROM public.users WHERE id = v_uid;

    RETURN jsonb_build_object('ok', true, 'deleted_company', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_own_account(BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
