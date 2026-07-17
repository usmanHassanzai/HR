-- Restore platform RPCs dropped by fix_live_deploy.sql and re-attach auth signup trigger.
-- Fixes: "Could not find the function public.platform_get_companies" and company registration not saving.

CREATE OR REPLACE FUNCTION public.get_my_company()
RETURNS TABLE(
    id UUID,
    name TEXT,
    status public.company_status,
    contact_email TEXT,
    contact_phone TEXT,
    subscription_plan public.subscription_plan,
    trial_ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
) AS $$
DECLARE
    v_company UUID;
BEGIN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN RETURN; END IF;
    RETURN QUERY
        SELECT c.id, c.name, c.status, c.contact_email, c.contact_phone,
               c.subscription_plan, c.trial_ends_at, c.created_at
        FROM public.companies c WHERE c.id = v_company;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

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
        ORDER BY
            CASE c.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
            c.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_get_notifications()
RETURNS SETOF public.platform_owner_notifications AS $$
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: platform owner only';
    END IF;
    RETURN QUERY
        SELECT * FROM public.platform_owner_notifications
        ORDER BY created_at DESC LIMIT 50;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_approve_company(p_company_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: platform owner only';
    END IF;
    UPDATE public.companies SET
        status = 'active',
        approved_by = auth.uid(),
        approved_at = timezone('utc'::text, now()),
        trial_ends_at = timezone('utc'::text, now()) + interval '14 days',
        updated_at = timezone('utc'::text, now())
    WHERE id = p_company_id AND status = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Company not found or not pending approval';
    END IF;

    UPDATE public.platform_owner_notifications SET read = true
    WHERE company_id = p_company_id AND read = false;

    INSERT INTO public.notifications (user_id, title, message, type)
    SELECT u.id, 'Company approved', 'Your company registration has been approved. You can now use Scorr.', 'info'
    FROM public.users u
    JOIN public.companies c ON c.owner_user_id = u.id
    WHERE c.id = p_company_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_reject_company(p_company_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: platform owner only';
    END IF;
    UPDATE public.companies SET
        status = 'rejected',
        rejected_reason = p_reason,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_company_id AND status = 'pending';

    INSERT INTO public.notifications (user_id, title, message, type)
    SELECT u.id, 'Company registration declined',
           coalesce(p_reason, 'Your company registration was not approved at this time.'),
           'alert'
    FROM public.users u
    JOIN public.companies c ON c.owner_user_id = u.id
    WHERE c.id = p_company_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_mark_notification_read(p_notification_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    UPDATE public.platform_owner_notifications SET read = true WHERE id = p_notification_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_company() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_get_companies() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_get_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_approve_company(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_reject_company(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_mark_notification_read(UUID) TO authenticated;

-- Signup trigger: drop_stale_functions_mid.sql CASCADE removes this; migrations never restored it.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Ensure handle_new_user uses FK-safe insert order (user row before owner_user_id link).
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
    v_sub public.subscription_plan;
    v_notify_msg TEXT;
BEGIN
    v_role := coalesce((NEW.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role);
    v_company_id_meta := NULLIF(NEW.raw_user_meta_data->>'company_id', '')::UUID;
    v_manager_id := NULLIF(NEW.raw_user_meta_data->>'manager_id', '')::UUID;
    v_dept_id_meta := NULLIF(NEW.raw_user_meta_data->>'department_id', '')::UUID;

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
            owner_user_id
        )
        VALUES (
            v_company_name, v_slug, 'pending', NEW.email,
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
            NULL
        )
        RETURNING id INTO v_company_id;

        INSERT INTO public.users (id, email, full_name, role, company_id, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email), 'admin', v_company_id, false);

        UPDATE public.companies SET owner_user_id = NEW.id WHERE id = v_company_id;

        v_notify_msg :=
            v_company_name || ' registered by ' || coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email)
            || E'\nEmail: ' || NEW.email
            || coalesce(E'\nPhone: ' || NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''), '')
            || E'\nPlan: ' || v_sub::text;

        INSERT INTO public.platform_owner_notifications (company_id, title, message)
        VALUES (v_company_id, 'New company registration — ' || v_company_name, v_notify_msg);

        INSERT INTO public.notifications (user_id, title, message, type)
        VALUES (
            NEW.id,
            'Registration submitted — awaiting approval',
            'Thank you for registering ' || v_company_name || '. Our admin will review your application shortly.',
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

    INSERT INTO public.users (id, email, full_name, role, company_id, department_id, manager_id, is_demo)
    VALUES (
        NEW.id, NEW.email,
        coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
        v_role, v_company_id_meta,
        v_dept_id_meta,
        v_manager_id,
        false
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Allow bootstrap (migrations + signup trigger) when no session user is present.
CREATE OR REPLACE FUNCTION public.seed_default_department_kpis(p_department_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
    v_dept_name TEXT;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT public.can_manage_department_kpis(p_department_id) THEN
        RAISE EXCEPTION 'Not authorized to seed KPIs for this department';
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM public.department_kpi_indicators
    WHERE department_id = p_department_id AND active = true;

    IF v_count > 0 THEN
        RETURN v_count;
    END IF;

    SELECT name INTO v_dept_name FROM public.departments WHERE id = p_department_id;

    INSERT INTO public.department_kpi_indicators (department_id, name, description, weight_pct, sort_order, active)
    VALUES
        (p_department_id, 'Performance Target / Volume',
         'Actual results versus monthly quota or target for ' || COALESCE(v_dept_name, 'the department') || '.',
         30.00, 1, true),
        (p_department_id, 'Quality & Accuracy',
         'Percentage of work passing quality checks.', 30.00, 2, true),
        (p_department_id, 'Timeliness / Delivery',
         'Tasks completed within the promised time frame.', 20.00, 3, true),
        (p_department_id, 'Efficiency & Productivity',
         'Average time to complete core department processes.', 20.00, 4, true)
    ON CONFLICT (department_id, name) DO NOTHING;

    SELECT COUNT(*) INTO v_count
    FROM public.department_kpi_indicators
    WHERE department_id = p_department_id AND active = true;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill auth users who signed up while the trigger was missing (company registration only).
DO $$
DECLARE
    au RECORD;
    v_company_id UUID;
    v_dept_id UUID;
    v_slug TEXT;
    v_company_name TEXT;
    v_sub public.subscription_plan;
    v_notify_msg TEXT;
BEGIN
    FOR au IN
        SELECT u.id, u.email, u.raw_user_meta_data
        FROM auth.users u
        WHERE coalesce(u.raw_user_meta_data->>'registration_type', '') = 'company'
          AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.owner_user_id = u.id OR lower(c.contact_email) = lower(u.email))
    LOOP
        v_company_name := trim(coalesce(au.raw_user_meta_data->>'company_name', 'New Company'));
        v_slug := lower(regexp_replace(v_company_name, '[^a-zA-Z0-9]+', '-', 'g'));
        v_slug := trim(both '-' from v_slug) || '-' || substr(replace(au.id::text, '-', ''), 1, 8);

        BEGIN
            v_sub := coalesce(
                NULLIF(trim(au.raw_user_meta_data->>'subscription_plan'), '')::public.subscription_plan,
                'trial'::public.subscription_plan
            );
        EXCEPTION WHEN OTHERS THEN
            v_sub := 'trial'::public.subscription_plan;
        END;

        INSERT INTO public.companies (
            name, slug, status, contact_email, contact_name, contact_phone,
            job_title, industry, employee_count, website,
            address_line, city, country, subscription_plan, registration_notes,
            owner_user_id
        )
        VALUES (
            v_company_name,
            v_slug,
            'pending',
            au.email,
            coalesce(au.raw_user_meta_data->>'full_name', au.email),
            NULLIF(trim(au.raw_user_meta_data->>'phone'), ''),
            NULLIF(trim(au.raw_user_meta_data->>'job_title'), ''),
            NULLIF(trim(au.raw_user_meta_data->>'industry'), ''),
            NULLIF(trim(au.raw_user_meta_data->>'employee_count'), ''),
            NULLIF(trim(au.raw_user_meta_data->>'website'), ''),
            NULLIF(trim(au.raw_user_meta_data->>'address_line'), ''),
            NULLIF(trim(au.raw_user_meta_data->>'city'), ''),
            NULLIF(trim(au.raw_user_meta_data->>'country'), ''),
            v_sub,
            NULLIF(trim(au.raw_user_meta_data->>'notes'), ''),
            NULL
        )
        RETURNING id INTO v_company_id;

        INSERT INTO public.users (id, email, full_name, role, company_id, is_demo)
        VALUES (au.id, au.email, coalesce(au.raw_user_meta_data->>'full_name', au.email), 'admin', v_company_id, false)
        ON CONFLICT (id) DO UPDATE SET
            company_id = EXCLUDED.company_id,
            role = 'admin'::public.user_role,
            full_name = EXCLUDED.full_name;

        UPDATE public.companies SET owner_user_id = au.id WHERE id = v_company_id;

        v_notify_msg :=
            v_company_name || ' registered by ' || coalesce(au.raw_user_meta_data->>'full_name', au.email)
            || E'\nEmail: ' || au.email;

        INSERT INTO public.platform_owner_notifications (company_id, title, message)
        VALUES (v_company_id, 'New company registration — ' || v_company_name, v_notify_msg);

        INSERT INTO public.departments (name, slug, org_weight_pct, company_id, active, is_demo)
        VALUES ('General', 'general-' || substr(replace(v_company_id::text, '-', ''), 1, 8), 100.00, v_company_id, true, false)
        RETURNING id INTO v_dept_id;

        BEGIN
            PERFORM public.seed_default_department_kpis(v_dept_id);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
