-- Auto-save sync: manager_id on signup, company branding in DB, attendance realtime.

-- ── User creation: manager_id from signup metadata ─────────────────────────
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ── Company branding in Supabase (syncs across devices) ──────────────────────
CREATE OR REPLACE FUNCTION public.get_company_branding()
RETURNS JSONB AS $$
DECLARE
    v_company UUID;
BEGIN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN RETURN NULL; END IF;
    RETURN (
        SELECT coalesce(c.settings->'branding', '{}'::jsonb)
        FROM public.companies c
        WHERE c.id = v_company
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.save_company_branding(p_branding JSONB)
RETURNS VOID AS $$
DECLARE
    v_company UUID;
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only company admins can update branding';
    END IF;
    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'No company context'; END IF;

    UPDATE public.companies
    SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{branding}', p_branding, true),
        updated_at = timezone('utc'::text, now())
    WHERE id = v_company;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_company_branding() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_company_branding(JSONB) TO authenticated;

-- ── Attendance realtime sync ───────────────────────────────────────────────
ALTER TABLE public.attendance_records REPLICA IDENTITY FULL;
ALTER TABLE public.leave_requests REPLICA IDENTITY FULL;

DO $$
BEGIN
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_records;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.leave_requests;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END $$;

NOTIFY pgrst, 'reload schema';
