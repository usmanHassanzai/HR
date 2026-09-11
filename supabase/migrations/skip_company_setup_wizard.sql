-- Skip the post-approval 4-step company setup wizard.
-- Mark onboarding complete on approve, and backfill active companies.

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
        trial_ends_at = timezone('utc'::text, now()) + interval '3 days',
        onboarding_completed_at = COALESCE(onboarding_completed_at, timezone('utc'::text, now())),
        updated_at = timezone('utc'::text, now())
    WHERE id = p_company_id AND status = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Company not found or not pending approval';
    END IF;

    UPDATE public.platform_owner_notifications SET read = true
    WHERE company_id = p_company_id AND read = false;

    INSERT INTO public.notifications (user_id, title, message, type)
    SELECT u.id,
           'Company approved',
           'Your company registration has been approved. Your 3-day trial has started — you can now use Scorr.',
           'info'
    FROM public.users u
    JOIN public.companies c ON c.owner_user_id = u.id
    WHERE c.id = p_company_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.platform_approve_company(UUID) TO authenticated;

UPDATE public.companies
SET onboarding_completed_at = COALESCE(approved_at, created_at, timezone('utc'::text, now()))
WHERE onboarding_completed_at IS NULL
  AND status = 'active';

NOTIFY pgrst, 'reload schema';
