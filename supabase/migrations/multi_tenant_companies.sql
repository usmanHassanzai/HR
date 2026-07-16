-- Multi-tenant SaaS: companies register → platform owner approves → isolated data per company
-- Demo accounts (is_demo) stay invisible to companies and platform owner dashboard

CREATE TYPE public.company_status AS ENUM ('pending', 'active', 'rejected', 'suspended');

CREATE TABLE IF NOT EXISTS public.companies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    status          public.company_status NOT NULL DEFAULT 'pending',
    contact_email   TEXT NOT NULL,
    contact_name    TEXT,
    owner_user_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by     UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    rejected_reason TEXT,
    trial_ends_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_companies_status ON public.companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_owner ON public.companies(owner_user_id);

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_platform_owner BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMPTZ;

ALTER TABLE public.departments
    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE;

-- Platform owner inbox (Samiya Kayani — not mixed with company notifications)
CREATE TABLE IF NOT EXISTS public.platform_owner_notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    message     TEXT NOT NULL,
    read        BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_platform_notifications_unread
    ON public.platform_owner_notifications(read) WHERE read = false;

-- Default platform owner email
CREATE OR REPLACE FUNCTION public.platform_owner_email()
RETURNS TEXT AS $$
    SELECT 'samiya@walfia.ai'::TEXT;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.is_platform_owner(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = p_user_id
          AND (
              u.is_platform_owner = true
              OR lower(u.email) = lower(public.platform_owner_email())
          )
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.current_company_id(p_user_id UUID DEFAULT auth.uid())
RETURNS UUID AS $$
    SELECT u.company_id FROM public.users u WHERE u.id = p_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.same_company(p_target_user_id UUID, p_caller_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
DECLARE
    v_caller_company UUID;
    v_target_company UUID;
BEGIN
    IF public.is_platform_owner(p_caller_id) THEN RETURN false; END IF;
    IF public.is_demo_user(p_caller_id) OR public.is_demo_user(p_target_user_id) THEN
        RETURN public.is_demo_user(p_caller_id) AND public.is_demo_user(p_target_user_id);
    END IF;
    SELECT company_id INTO v_caller_company FROM public.users WHERE id = p_caller_id;
    SELECT company_id INTO v_target_company FROM public.users WHERE id = p_target_user_id;
    RETURN v_caller_company IS NOT NULL
       AND v_target_company IS NOT NULL
       AND v_caller_company = v_target_company;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.company_is_active(p_company_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.companies c
        WHERE c.id = p_company_id AND c.status = 'active'
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.is_demo_expired(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = p_user_id
          AND u.is_demo = true
          AND u.demo_expires_at IS NOT NULL
          AND u.demo_expires_at < timezone('utc'::text, now())
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 3-day demo expiry for sandbox accounts
UPDATE public.users
SET demo_expires_at = created_at + interval '3 days'
WHERE is_demo = true AND demo_expires_at IS NULL;

-- Mark platform owner if account exists
UPDATE public.users
SET is_platform_owner = true
WHERE lower(email) = lower(public.platform_owner_email());

-- Migrate existing non-demo production users into a default company (one-time)
DO $$
DECLARE
    v_default_id UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE slug = 'walfia-default') THEN
        INSERT INTO public.companies (name, slug, status, contact_email, contact_name, approved_at)
        VALUES ('Walfia Default', 'walfia-default', 'active', 'admin@walfia.ai', 'Legacy Admin', timezone('utc'::text, now()))
        RETURNING id INTO v_default_id;

        UPDATE public.users
        SET company_id = v_default_id
        WHERE is_demo = false
          AND is_platform_owner = false
          AND company_id IS NULL
          AND lower(email) NOT IN (
              lower(public.platform_owner_email()),
              'admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai'
          );

        UPDATE public.departments
        SET company_id = v_default_id
        WHERE company_id IS NULL AND is_demo = false;
    END IF;
END $$;

-- Company registration trigger: owner signs up with registration_type = company
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_company_name TEXT;
    v_company_id UUID;
    v_dept_id UUID;
    v_slug TEXT;
    v_role public.user_role;
    v_company_id_meta UUID;
BEGIN
    v_role := coalesce((NEW.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role);
    v_company_id_meta := NULLIF(NEW.raw_user_meta_data->>'company_id', '')::UUID;

    IF NEW.raw_user_meta_data->>'registration_type' = 'company' THEN
        v_company_name := trim(coalesce(NEW.raw_user_meta_data->>'company_name', 'New Company'));
        v_slug := lower(regexp_replace(v_company_name, '[^a-zA-Z0-9]+', '-', 'g'));
        v_slug := trim(both '-' from v_slug) || '-' || substr(replace(NEW.id::text, '-', ''), 1, 8);

        INSERT INTO public.companies (name, slug, status, contact_email, contact_name, owner_user_id)
        VALUES (
            v_company_name,
            v_slug,
            'pending',
            NEW.email,
            coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
            NEW.id
        )
        RETURNING id INTO v_company_id;

        INSERT INTO public.users (id, email, full_name, role, company_id, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email), 'admin', v_company_id, false);

        INSERT INTO public.platform_owner_notifications (company_id, title, message)
        VALUES (
            v_company_id,
            'New company registration',
            v_company_name || ' (' || NEW.email || ') has requested access. Review and approve in the Platform Console.'
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

    -- Platform owner account
    IF lower(NEW.email) = lower(public.platform_owner_email()) THEN
        INSERT INTO public.users (id, email, full_name, role, is_platform_owner, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', 'Samiya Kayani'), 'admin', true, false);
        RETURN NEW;
    END IF;

    -- Demo users
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

    -- Company admin creating employee/manager/admin
    INSERT INTO public.users (id, email, full_name, role, company_id, is_demo)
    VALUES (
        NEW.id,
        NEW.email,
        coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
        v_role,
        v_company_id_meta,
        false
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Admin user list: scoped to same company; never shows demo or other companies
CREATE OR REPLACE FUNCTION public.get_all_users_admin()
RETURNS SETOF public.users AS $$
DECLARE
    v_company UUID;
BEGIN
    IF public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Platform owner must use platform console, not company admin dashboard';
    END IF;
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    IF public.is_demo_user(auth.uid()) THEN
        RETURN QUERY SELECT u.* FROM public.users u WHERE u.is_demo = true ORDER BY u.created_at DESC;
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
        ORDER BY u.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_direct_reports(p_manager_id UUID)
RETURNS SETOF public.users AS $$
BEGIN
    IF auth.uid() IS DISTINCT FROM p_manager_id
       AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    PERFORM public.enforce_demo_isolation(p_manager_id);
    IF NOT public.is_demo_user(auth.uid()) AND NOT public.same_company(p_manager_id) THEN
        RAISE EXCEPTION 'Cannot view users from another company';
    END IF;
    RETURN QUERY
        SELECT u.* FROM public.users u
        WHERE u.manager_id = p_manager_id
          AND (NOT public.is_demo_user(auth.uid()) OR u.is_demo = true)
          AND (public.is_demo_user(auth.uid()) OR u.company_id = public.current_company_id())
        ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_departments()
RETURNS TABLE(
    id UUID,
    name TEXT,
    slug TEXT,
    org_weight_pct NUMERIC,
    active BOOLEAN,
    kpi_count BIGINT,
    active_kpi_count BIGINT,
    indicator_count BIGINT
) AS $$
DECLARE
    v_company UUID;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    IF public.is_demo_user(auth.uid()) THEN
        RETURN QUERY
        SELECT d.id, d.name, d.slug, d.org_weight_pct, d.active,
               COUNT(DISTINCT k.id), COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
               COUNT(DISTINCT i.id) FILTER (WHERE i.active = true)
        FROM public.departments d
        LEFT JOIN public.kpis k ON k.department_id = d.id
        LEFT JOIN public.department_kpi_indicators i ON i.department_id = d.id
        WHERE d.active = true AND d.is_demo = true
        GROUP BY d.id ORDER BY d.name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

    RETURN QUERY
    SELECT d.id, d.name, d.slug, d.org_weight_pct, d.active,
           COUNT(DISTINCT k.id), COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
           COUNT(DISTINCT i.id) FILTER (WHERE i.active = true)
    FROM public.departments d
    LEFT JOIN public.kpis k ON k.department_id = d.id
    LEFT JOIN public.department_kpi_indicators i ON i.department_id = d.id
    WHERE d.active = true AND d.company_id = v_company
    GROUP BY d.id ORDER BY d.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_my_company()
RETURNS TABLE(
    id UUID,
    name TEXT,
    status public.company_status,
    contact_email TEXT,
    trial_ends_at TIMESTAMPTZ
) AS $$
DECLARE
    v_company UUID;
BEGIN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN RETURN; END IF;
    RETURN QUERY
        SELECT c.id, c.name, c.status, c.contact_email, c.trial_ends_at
        FROM public.companies c WHERE c.id = v_company;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Platform owner RPCs (Samiya Kayani console)
CREATE OR REPLACE FUNCTION public.platform_get_companies()
RETURNS TABLE(
    id UUID,
    name TEXT,
    slug TEXT,
    status public.company_status,
    contact_email TEXT,
    contact_name TEXT,
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

GRANT EXECUTE ON FUNCTION public.is_platform_owner(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_company_id(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_company() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_demo_expired(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_get_companies() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_get_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_approve_company(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_reject_company(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_mark_notification_read(UUID) TO authenticated;

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_owner_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS companies_platform_owner ON public.companies;
CREATE POLICY companies_platform_owner ON public.companies
    FOR SELECT USING (public.is_platform_owner());

DROP POLICY IF EXISTS companies_member_read ON public.companies;
CREATE POLICY companies_member_read ON public.companies
    FOR SELECT USING (id = public.current_company_id());

DROP POLICY IF EXISTS platform_notifications_owner ON public.platform_owner_notifications;
CREATE POLICY platform_notifications_owner ON public.platform_owner_notifications
    FOR ALL USING (public.is_platform_owner());
