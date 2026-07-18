-- Platform owner (info@walfia.ai) keeps full org admin dashboard + Registered Companies tab.
-- Link owner to Walfia home company and allow company-scoped RLS (not block all org data).

DO $$
DECLARE
    v_company UUID;
BEGIN
    SELECT id INTO v_company FROM public.companies WHERE slug = 'walfia-default' LIMIT 1;
    IF v_company IS NULL THEN
        INSERT INTO public.companies (name, slug, status, contact_email, contact_name, approved_at)
        VALUES ('Walfia', 'walfia-default', 'active', 'info@walfia.ai', 'Walfia Admin', timezone('utc'::text, now()))
        RETURNING id INTO v_company;
    END IF;

    UPDATE public.users
    SET company_id = v_company
    WHERE (
        is_platform_owner = true
        OR lower(email) = lower(public.platform_owner_email())
    )
    AND company_id IS NULL;
END $$;

CREATE OR REPLACE FUNCTION public.same_company(p_target_user_id UUID, p_caller_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
DECLARE
    v_caller_company UUID;
    v_target_company UUID;
BEGIN
    IF public.is_demo_user(p_caller_id) OR public.is_demo_user(p_target_user_id) THEN
        RETURN public.is_demo_user(p_caller_id) AND public.is_demo_user(p_target_user_id);
    END IF;

    SELECT company_id INTO v_caller_company FROM public.users WHERE id = p_caller_id;
    SELECT company_id INTO v_target_company FROM public.users WHERE id = p_target_user_id;

    IF public.is_platform_owner(p_caller_id) THEN
        RETURN v_caller_company IS NOT NULL
           AND v_target_company IS NOT NULL
           AND v_caller_company = v_target_company;
    END IF;

    RETURN v_caller_company IS NOT NULL
       AND v_target_company IS NOT NULL
       AND v_caller_company = v_target_company;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_access_user_data(p_target_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF p_target_user_id IS NULL THEN RETURN false; END IF;

    IF public.is_platform_owner(auth.uid()) THEN
        IF auth.uid() = p_target_user_id THEN RETURN true; END IF;
        IF public.current_company_id() IS NULL THEN RETURN false; END IF;
        RETURN EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = p_target_user_id
              AND u.company_id = public.current_company_id()
              AND u.is_demo = false
        );
    END IF;

    IF public.is_demo_user(auth.uid()) THEN
        RETURN public.is_demo_user(p_target_user_id);
    END IF;

    IF auth.uid() = p_target_user_id THEN RETURN true; END IF;

    IF NOT public.same_company(p_target_user_id) THEN RETURN false; END IF;

    IF public.is_admin(auth.uid()) THEN RETURN true; END IF;

    RETURN public.is_manager_of(auth.uid(), p_target_user_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_access_department(p_department_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF p_department_id IS NULL THEN RETURN false; END IF;

    IF public.is_platform_owner(auth.uid()) THEN
        IF public.current_company_id() IS NULL THEN RETURN false; END IF;
        RETURN EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = p_department_id
              AND d.company_id = public.current_company_id()
        );
    END IF;

    IF public.is_demo_user(auth.uid()) THEN
        RETURN EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = p_department_id AND d.is_demo = true
        );
    END IF;

    IF public.is_admin(auth.uid()) THEN
        RETURN EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = p_department_id AND d.company_id = public.current_company_id()
        );
    END IF;

    RETURN public.manager_can_access_department(p_department_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_all_users_admin()
RETURNS SETOF public.users AS $$
DECLARE
    v_company UUID;
BEGIN
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
