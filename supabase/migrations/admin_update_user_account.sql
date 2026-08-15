-- Admin can update employee / manager / admin profile fields in their company.

CREATE OR REPLACE FUNCTION public.admin_update_user_account(
    p_user_id UUID,
    p_full_name TEXT,
    p_role TEXT,
    p_department_id UUID DEFAULT NULL,
    p_manager_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_target public.users%ROWTYPE;
    v_role public.user_role;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only company admin can edit user accounts';
    END IF;

    IF trim(coalesce(p_full_name, '')) = '' THEN
        RAISE EXCEPTION 'Full name is required';
    END IF;

    IF p_role NOT IN ('employee', 'manager', 'admin') THEN
        RAISE EXCEPTION 'Invalid role';
    END IF;
    v_role := p_role::public.user_role;

    v_company := public.current_company_id();

    SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    IF v_company IS NOT NULL AND v_target.company_id IS DISTINCT FROM v_company THEN
        RAISE EXCEPTION 'User is not in your company';
    END IF;

    IF p_user_id = v_uid AND v_role <> 'admin'::public.user_role THEN
        RAISE EXCEPTION 'You cannot remove your own admin role';
    END IF;

    IF v_role <> 'admin'::public.user_role AND p_department_id IS NULL THEN
        RAISE EXCEPTION 'Department is required for managers and employees';
    END IF;

    IF p_manager_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.users m
            WHERE m.id = p_manager_id
              AND m.role IN ('manager'::public.user_role, 'admin'::public.user_role)
              AND (v_company IS NULL OR m.company_id = v_company)
        ) THEN
            RAISE EXCEPTION 'Selected manager/admin is invalid';
        END IF;
    END IF;

    UPDATE public.users u
    SET
        full_name = trim(p_full_name),
        role = v_role,
        department_id = CASE WHEN v_role = 'admin'::public.user_role THEN NULL ELSE p_department_id END,
        manager_id = CASE WHEN v_role = 'admin'::public.user_role THEN NULL ELSE p_manager_id END,
        updated_at = timezone('utc'::text, now())
    WHERE u.id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.admin_update_user_account(UUID, TEXT, TEXT, UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
