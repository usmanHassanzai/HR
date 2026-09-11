-- Platform owner can edit any registered organization's profile and status.

CREATE OR REPLACE FUNCTION public.platform_update_company(
    p_company_id UUID,
    p_name TEXT,
    p_contact_name TEXT DEFAULT NULL,
    p_contact_email TEXT DEFAULT NULL,
    p_contact_phone TEXT DEFAULT NULL,
    p_job_title TEXT DEFAULT NULL,
    p_industry TEXT DEFAULT NULL,
    p_employee_count TEXT DEFAULT NULL,
    p_website TEXT DEFAULT NULL,
    p_address_line TEXT DEFAULT NULL,
    p_city TEXT DEFAULT NULL,
    p_country TEXT DEFAULT NULL,
    p_subscription_plan TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_registration_notes TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT := trim(COALESCE(p_name, ''));
    v_email TEXT := NULLIF(trim(COALESCE(p_contact_email, '')), '');
    v_plan public.subscription_plan;
    v_status public.company_status;
    v_prev public.companies%ROWTYPE;
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: platform owner only';
    END IF;

    IF p_company_id IS NULL THEN
        RAISE EXCEPTION 'Company id is required';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'Company name is required';
    END IF;

    IF v_email IS NULL OR v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'A valid contact email is required';
    END IF;

    SELECT * INTO v_prev FROM public.companies WHERE id = p_company_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Company not found';
    END IF;

    IF p_subscription_plan IS NULL OR trim(p_subscription_plan) = '' THEN
        v_plan := COALESCE(v_prev.subscription_plan, 'trial'::public.subscription_plan);
    ELSE
        BEGIN
            v_plan := trim(p_subscription_plan)::public.subscription_plan;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Invalid subscription plan';
        END;
    END IF;

    IF p_status IS NULL OR trim(p_status) = '' THEN
        v_status := v_prev.status;
    ELSE
        BEGIN
            v_status := trim(p_status)::public.company_status;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Invalid status';
        END;
    END IF;

    UPDATE public.companies SET
        name = v_name,
        contact_name = NULLIF(trim(COALESCE(p_contact_name, '')), ''),
        contact_email = v_email,
        contact_phone = NULLIF(trim(COALESCE(p_contact_phone, '')), ''),
        job_title = NULLIF(trim(COALESCE(p_job_title, '')), ''),
        industry = NULLIF(trim(COALESCE(p_industry, '')), ''),
        employee_count = NULLIF(trim(COALESCE(p_employee_count, '')), ''),
        website = NULLIF(trim(COALESCE(p_website, '')), ''),
        address_line = NULLIF(trim(COALESCE(p_address_line, '')), ''),
        city = NULLIF(trim(COALESCE(p_city, '')), ''),
        country = NULLIF(trim(COALESCE(p_country, '')), ''),
        subscription_plan = v_plan,
        status = v_status,
        registration_notes = NULLIF(trim(COALESCE(p_registration_notes, '')), ''),
        approved_at = CASE
            WHEN v_status = 'active'::public.company_status AND v_prev.approved_at IS NULL
                THEN timezone('utc'::text, now())
            WHEN v_status <> 'active'::public.company_status
                THEN approved_at
            ELSE approved_at
        END,
        onboarding_completed_at = CASE
            WHEN v_status = 'active'::public.company_status
                THEN COALESCE(onboarding_completed_at, timezone('utc'::text, now()))
            ELSE onboarding_completed_at
        END,
        trial_ends_at = CASE
            WHEN v_status = 'active'::public.company_status AND trial_ends_at IS NULL
                THEN timezone('utc'::text, now()) + interval '3 days'
            ELSE trial_ends_at
        END,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_update_company(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

NOTIFY pgrst, 'reload schema';
