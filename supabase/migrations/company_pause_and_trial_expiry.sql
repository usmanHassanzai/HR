-- Company pause / trial expiry:
-- - Trial plans auto-suspend when trial_ends_at passes
-- - Platform owner (info@walfia.ai) can pause or resume any company

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.companies.paused_reason IS
  'Why the company is suspended: trial_expired, billing, or platform_owner note.';

CREATE OR REPLACE FUNCTION public.pause_expired_trial_companies()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER := 0;
BEGIN
  UPDATE public.companies c
  SET
    status = 'suspended'::public.company_status,
    paused_reason = COALESCE(NULLIF(trim(c.paused_reason), ''), 'trial_expired'),
    paused_at = COALESCE(c.paused_at, timezone('utc'::text, now())),
    updated_at = timezone('utc'::text, now())
  WHERE c.status = 'active'::public.company_status
    AND COALESCE(c.subscription_plan::text, 'trial') = 'trial'
    AND c.trial_ends_at IS NOT NULL
    AND c.trial_ends_at < timezone('utc'::text, now())
    AND COALESCE(c.slug, '') <> 'walfia-default'
    AND lower(trim(c.name)) NOT IN ('walfia', 'walfia default');

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_company_access_state(p_company_id UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_company_id IS NULL THEN
    PERFORM public.pause_expired_trial_companies();
    RETURN;
  END IF;

  UPDATE public.companies c
  SET
    status = 'suspended'::public.company_status,
    paused_reason = COALESCE(NULLIF(trim(c.paused_reason), ''), 'trial_expired'),
    paused_at = COALESCE(c.paused_at, timezone('utc'::text, now())),
    updated_at = timezone('utc'::text, now())
  WHERE c.id = p_company_id
    AND c.status = 'active'::public.company_status
    AND COALESCE(c.subscription_plan::text, 'trial') = 'trial'
    AND c.trial_ends_at IS NOT NULL
    AND c.trial_ends_at < timezone('utc'::text, now())
    AND COALESCE(c.slug, '') <> 'walfia-default'
    AND lower(trim(c.name)) NOT IN ('walfia', 'walfia default');
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_pause_company(
  p_company_id UUID,
  p_reason TEXT DEFAULT 'billing'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason TEXT := NULLIF(trim(COALESCE(p_reason, '')), '');
BEGIN
  IF NOT public.is_platform_owner(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized: platform owner only';
  END IF;
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'Company id is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.companies c
    WHERE c.id = p_company_id
      AND (
        c.slug = 'walfia-default'
        OR lower(trim(c.name)) IN ('walfia', 'walfia default')
      )
  ) THEN
    RAISE EXCEPTION 'The Walfia default organization cannot be paused';
  END IF;

  UPDATE public.companies
  SET
    status = 'suspended'::public.company_status,
    paused_reason = COALESCE(v_reason, 'billing'),
    paused_at = timezone('utc'::text, now()),
    paused_by = auth.uid(),
    updated_at = timezone('utc'::text, now())
  WHERE id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_resume_company(
  p_company_id UUID,
  p_subscription_plan TEXT DEFAULT NULL,
  p_extend_trial_days INTEGER DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev public.companies%ROWTYPE;
  v_plan public.subscription_plan;
  v_extend INTEGER := GREATEST(COALESCE(p_extend_trial_days, 0), 0);
BEGIN
  IF NOT public.is_platform_owner(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized: platform owner only';
  END IF;
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'Company id is required';
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

  -- Resuming a trial that already ended: give another trial window (default 3 days)
  IF v_plan = 'trial'::public.subscription_plan THEN
    IF v_extend <= 0 THEN
      IF v_prev.trial_ends_at IS NULL OR v_prev.trial_ends_at < timezone('utc'::text, now()) THEN
        v_extend := 3;
      END IF;
    END IF;
  ELSE
    v_extend := 0;
  END IF;

  UPDATE public.companies
  SET
    status = 'active'::public.company_status,
    subscription_plan = v_plan,
    trial_ends_at = CASE
      WHEN v_plan = 'trial'::public.subscription_plan AND v_extend > 0
        THEN timezone('utc'::text, now()) + make_interval(days => v_extend)
      WHEN v_plan = 'trial'::public.subscription_plan
        THEN COALESCE(trial_ends_at, timezone('utc'::text, now()) + interval '3 days')
      ELSE trial_ends_at
    END,
    paused_reason = NULL,
    paused_at = NULL,
    paused_by = NULL,
    onboarding_completed_at = COALESCE(onboarding_completed_at, timezone('utc'::text, now())),
    approved_at = COALESCE(approved_at, timezone('utc'::text, now())),
    updated_at = timezone('utc'::text, now())
  WHERE id = p_company_id;
END;
$$;

-- Auto-enforce trial expiry whenever a member loads their company.
DROP FUNCTION IF EXISTS public.get_my_company();
CREATE OR REPLACE FUNCTION public.get_my_company()
RETURNS TABLE(
    id UUID,
    name TEXT,
    status public.company_status,
    contact_email TEXT,
    contact_phone TEXT,
    subscription_plan public.subscription_plan,
    trial_ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    onboarding_completed_at TIMESTAMPTZ,
    paused_reason TEXT,
    paused_at TIMESTAMPTZ
) AS $$
DECLARE
    v_company UUID;
BEGIN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN RETURN; END IF;

    PERFORM public.enforce_company_access_state(v_company);

    RETURN QUERY
        SELECT c.id, c.name, c.status, c.contact_email, c.contact_phone,
               c.subscription_plan, c.trial_ends_at, c.created_at, c.onboarding_completed_at,
               c.paused_reason, c.paused_at
        FROM public.companies c WHERE c.id = v_company;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Include trial / pause fields for platform console.
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
    user_count BIGINT,
    trial_ends_at TIMESTAMPTZ,
    paused_reason TEXT,
    paused_at TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: platform owner only';
    END IF;

    PERFORM public.pause_expired_trial_companies();

    RETURN QUERY
        SELECT
            c.id, c.name, c.slug, c.status, c.contact_email, c.contact_name,
            c.contact_phone, c.job_title, c.industry, c.employee_count, c.website,
            c.address_line, c.city, c.country, c.subscription_plan, c.registration_notes,
            u.email, u.full_name, c.created_at, c.approved_at,
            (SELECT COUNT(*) FROM public.users u2 WHERE u2.company_id = c.id AND u2.is_demo = false),
            c.trial_ends_at, c.paused_reason, c.paused_at
        FROM public.companies c
        LEFT JOIN public.users u ON u.id = c.owner_user_id
        ORDER BY c.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- One-time catch-up for already-expired trials
SELECT public.pause_expired_trial_companies();

GRANT EXECUTE ON FUNCTION public.pause_expired_trial_companies() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_company_access_state(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_pause_company(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_resume_company(UUID, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_company() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_get_companies() TO authenticated;

NOTIFY pgrst, 'reload schema';
