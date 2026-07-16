-- Extended company registration fields + owner notifications on signup

DO $$ BEGIN
    CREATE TYPE public.subscription_plan AS ENUM ('starter', 'professional', 'enterprise', 'trial');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS contact_phone TEXT,
    ADD COLUMN IF NOT EXISTS job_title TEXT,
    ADD COLUMN IF NOT EXISTS industry TEXT,
    ADD COLUMN IF NOT EXISTS employee_count TEXT,
    ADD COLUMN IF NOT EXISTS website TEXT,
    ADD COLUMN IF NOT EXISTS address_line TEXT,
    ADD COLUMN IF NOT EXISTS city TEXT,
    ADD COLUMN IF NOT EXISTS country TEXT,
    ADD COLUMN IF NOT EXISTS subscription_plan public.subscription_plan DEFAULT 'trial',
    ADD COLUMN IF NOT EXISTS registration_notes TEXT;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_company_name TEXT;
    v_company_id UUID;
    v_dept_id UUID;
    v_slug TEXT;
    v_role public.user_role;
    v_company_id_meta UUID;
    v_sub public.subscription_plan;
    v_notify_msg TEXT;
BEGIN
    v_role := coalesce((NEW.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role);
    v_company_id_meta := NULLIF(NEW.raw_user_meta_data->>'company_id', '')::UUID;

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
            v_company_name,
            v_slug,
            'pending',
            NEW.email,
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
            NEW.id
        )
        RETURNING id INTO v_company_id;

        INSERT INTO public.users (id, email, full_name, role, company_id, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email), 'admin', v_company_id, false);

        v_notify_msg :=
            v_company_name || ' registered by ' || coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email)
            || E'\nEmail: ' || NEW.email
            || coalesce(E'\nPhone: ' || NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''), '')
            || E'\nPlan: ' || v_sub::text
            || coalesce(E'\nIndustry: ' || NULLIF(trim(NEW.raw_user_meta_data->>'industry'), ''), '')
            || E'\n\nApprove at: https://scorr.walfia.ai/platform';

        INSERT INTO public.platform_owner_notifications (company_id, title, message)
        VALUES (v_company_id, 'New company registration — ' || v_company_name, v_notify_msg);

        INSERT INTO public.notifications (user_id, title, message, type)
        VALUES (
            NEW.id,
            'Registration submitted — awaiting approval',
            'Thank you for registering ' || v_company_name || '. Our admin will review your application shortly. You will receive another notification when your account is approved.',
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

    INSERT INTO public.users (id, email, full_name, role, company_id, department_id, is_demo)
    VALUES (
        NEW.id, NEW.email,
        coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
        v_role, v_company_id_meta,
        NULLIF(NEW.raw_user_meta_data->>'department_id', '')::UUID,
        false
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

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

DROP FUNCTION IF EXISTS public.platform_get_companies();

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

GRANT EXECUTE ON FUNCTION public.platform_get_companies() TO authenticated;
