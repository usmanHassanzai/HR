-- Platform owner (Samiya) must read their own profile for admin dashboard + platform console.
-- Previous can_access_user_data returned false for ALL rows when caller is platform owner.

CREATE OR REPLACE FUNCTION public.can_access_user_data(p_target_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF p_target_user_id IS NULL THEN RETURN false; END IF;

    IF public.is_platform_owner(auth.uid()) THEN
        RETURN auth.uid() = p_target_user_id;
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

-- Reliable session bootstrap for the admin UI (works even if profile columns are stale)
CREATE OR REPLACE FUNCTION public.get_my_session_info()
RETURNS TABLE(
    is_platform_owner BOOLEAN,
    role public.user_role,
    email TEXT,
    full_name TEXT
) AS $$
BEGIN
    IF auth.uid() IS NULL THEN RETURN; END IF;
    RETURN QUERY
        SELECT
            public.is_platform_owner(auth.uid()),
            u.role,
            u.email,
            u.full_name
        FROM public.users u
        WHERE u.id = auth.uid();
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_session_info() TO authenticated;
