-- Platform owner (Samiya) can delete any registered company and all its data

CREATE OR REPLACE FUNCTION public.platform_delete_company(p_company_id UUID)
RETURNS VOID AS $$
DECLARE
    rec RECORD;
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

    -- Remove all company users (auth cascade → public.users, kpis, tasks, etc.)
    FOR rec IN
        SELECT u.id FROM public.users u
        WHERE u.company_id = p_company_id
          AND u.is_demo = false
          AND u.is_platform_owner = false
    LOOP
        DELETE FROM auth.users WHERE id = rec.id;
    END LOOP;

    -- Orphan any remaining public.users rows (safety)
    DELETE FROM public.users
    WHERE company_id = p_company_id
      AND is_demo = false
      AND is_platform_owner = false;

    -- Departments + indicators cascade from company; notifications cascade too
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
