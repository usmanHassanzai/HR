-- iOS Home Screen location UX is client-side; this migration re-asserts
-- iOS silence helpers remain after laptop rules and stays LAST in apply-all.
-- Re-runnable. Does NOT change Android / desktop / web / check-in / Rule 6.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS ios_office_signal_timeout INTEGER NOT NULL DEFAULT 30;

UPDATE public.companies
SET ios_office_signal_timeout = 30
WHERE ios_office_signal_timeout IS NULL OR ios_office_signal_timeout < 1;

ALTER TABLE public.companies
  ALTER COLUMN ios_office_signal_timeout SET DEFAULT 30;

-- Ensure helpers still exist (idempotent CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.attendance_user_uses_ios_silence_rules(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_has_ios boolean := false;
  v_non_ios_in_visit boolean := false;
  v_visit_in timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT MAX(clock_in_at) INTO v_visit_in
  FROM public.attendance_visit_segments
  WHERE user_id = p_user_id
    AND clock_in_at IS NOT NULL
    AND clock_out_at IS NULL;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
      AND lower(COALESCE(d.platform, '')) IN ('ios', 'iphone', 'ipad')
  ) INTO v_has_ios;

  IF NOT v_has_ios THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
      AND lower(COALESCE(d.platform, '')) NOT IN ('ios', 'iphone', 'ipad')
      AND d.last_seen_at IS NOT NULL
      AND d.last_seen_at >= COALESCE(v_visit_in, timezone('utc', now()) - INTERVAL '12 hours')
  ) INTO v_non_ios_in_visit;

  RETURN NOT v_non_ios_in_visit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_user_uses_ios_silence_rules(uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
