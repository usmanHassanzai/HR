-- Job title / staff type for employees and managers (free text).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS job_title TEXT;

COMMENT ON COLUMN public.users.job_title IS
  'What type of employee or manager this person is (e.g. Software Engineer, Sales Manager).';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_company_name TEXT;
    v_company_id UUID;
    v_dept_id UUID;
    v_slug TEXT;
    v_role public.user_role;
    v_company_id_meta UUID;
    v_manager_id UUID;
    v_dept_id_meta UUID;
    v_job_title TEXT;
    v_sub public.subscription_plan;
    v_notify_msg TEXT;
BEGIN
    v_role := coalesce((NEW.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role);
    v_company_id_meta := NULLIF(NEW.raw_user_meta_data->>'company_id', '')::UUID;
    v_manager_id := NULLIF(NEW.raw_user_meta_data->>'manager_id', '')::UUID;
    v_dept_id_meta := NULLIF(NEW.raw_user_meta_data->>'department_id', '')::UUID;
    v_job_title := NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'job_title', '')), '');

    IF NEW.raw_user_meta_data->>'registration_type' = 'company' THEN
        v_company_name := trim(coalesce(NEW.raw_user_meta_data->>'company_name', 'New Company'));
        v_slug := lower(regexp_replace(v_company_name, '[^a-zA-Z0-9]+', '-', 'g'));
        v_slug := trim(both '-' from v_slug) || '-' || substr(replace(NEW.id::text, '-', ''), 1, 8);

        BEGIN
            v_sub := coalesce(
                NULLIF(trim(NEW.raw_user_meta_data->>'subscription_plan'), '')::public.subscription_plan,
                'trial'::public.subscription_plan
            );
        EXCEPTION WHEN OTHERS THEN
            v_sub := 'trial'::public.subscription_plan;
        END;

        INSERT INTO public.companies (
            name, slug, status, contact_email, contact_name, contact_phone,
            job_title, industry, employee_count, website,
            address_line, city, country, subscription_plan, registration_notes,
            owner_user_id, trial_ends_at, approved_at
        )
        VALUES (
            v_company_name, v_slug, 'active', NEW.email,
            coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
            NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'job_title'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'industry'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'employee_count'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'website'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'address_line'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'city'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'country'), ''),
            v_sub,
            NULLIF(trim(NEW.raw_user_meta_data->>'notes'), ''),
            NULL,
            timezone('utc'::text, now()) + interval '3 days',
            timezone('utc'::text, now())
        )
        RETURNING id INTO v_company_id;

        INSERT INTO public.users (id, email, full_name, role, company_id, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email), 'admin', v_company_id, false);

        UPDATE public.companies SET owner_user_id = NEW.id WHERE id = v_company_id;

        v_notify_msg :=
            v_company_name || ' started a 3-day trial. Admin: '
            || coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email)
            || E'\nEmail: ' || NEW.email
            || coalesce(E'\nPhone: ' || NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''), '');

        INSERT INTO public.platform_owner_notifications (company_id, title, message)
        VALUES (v_company_id, 'New company trial — ' || v_company_name, v_notify_msg);

        INSERT INTO public.notifications (user_id, title, message, type)
        VALUES (
            NEW.id,
            'Welcome to Scorr',
            'Your 3-day trial for ' || v_company_name || ' is live. Complete the short setup wizard to add people, shifts, and KPIs.',
            'info'
        );

        INSERT INTO public.departments (name, slug, org_weight_pct, company_id, active, is_demo)
        VALUES ('General', 'general-' || substr(replace(v_company_id::text, '-', ''), 1, 8), 100.00, v_company_id, true, false)
        RETURNING id INTO v_dept_id;

        IF EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'seed_default_department_kpis'
        ) THEN
            PERFORM public.seed_default_department_kpis(v_dept_id);
        END IF;

        RETURN NEW;
    END IF;

    IF lower(NEW.email) = lower(public.platform_owner_email()) THEN
        INSERT INTO public.users (id, email, full_name, role, is_platform_owner, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', 'Samiya Kayani'), 'admin', true, false);
        RETURN NEW;
    END IF;

    IF NEW.email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai')
       OR (NEW.raw_user_meta_data->>'is_demo')::boolean IS true THEN
        INSERT INTO public.users (id, email, full_name, role, is_demo, demo_expires_at)
        VALUES (
            NEW.id, NEW.email,
            coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
            v_role, true,
            timezone('utc'::text, now()) + interval '3 days'
        );
        RETURN NEW;
    END IF;

    IF v_company_id_meta IS NULL THEN
        RAISE EXCEPTION 'Company is required to create a user';
    END IF;

    IF v_role IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        IF v_dept_id_meta IS NULL THEN
            RAISE EXCEPTION 'Department is required for employees and managers';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = v_dept_id_meta
              AND d.company_id = v_company_id_meta
              AND COALESCE(d.active, true)
        ) THEN
            RAISE EXCEPTION 'Department must belong to the same company';
        END IF;
    ELSE
        v_dept_id_meta := NULL;
        v_manager_id := NULL;
        v_job_title := NULL;
    END IF;

    INSERT INTO public.users (id, email, full_name, role, company_id, department_id, manager_id, job_title, is_demo)
    VALUES (
        NEW.id, NEW.email,
        coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
        v_role, v_company_id_meta,
        v_dept_id_meta,
        v_manager_id,
        v_job_title,
        false
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP FUNCTION IF EXISTS public.admin_update_user_account(UUID, TEXT, TEXT, UUID, UUID);
CREATE OR REPLACE FUNCTION public.admin_update_user_account(
    p_user_id UUID,
    p_full_name TEXT,
    p_role TEXT,
    p_department_id UUID DEFAULT NULL,
    p_manager_id UUID DEFAULT NULL,
    p_job_title TEXT DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_target public.users%ROWTYPE;
    v_role public.user_role;
    v_needs_dept BOOLEAN;
    v_title TEXT := NULLIF(trim(COALESCE(p_job_title, '')), '');
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

    IF NOT v_needs_dept THEN
        v_title := NULL;
    END IF;

    UPDATE public.users u
    SET
        full_name = trim(p_full_name),
        role = v_role,
        department_id = CASE WHEN v_needs_dept THEN p_department_id ELSE NULL END,
        manager_id = CASE WHEN v_needs_dept THEN p_manager_id ELSE NULL END,
        job_title = v_title
    WHERE u.id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.admin_update_user_account(UUID, TEXT, TEXT, UUID, UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
