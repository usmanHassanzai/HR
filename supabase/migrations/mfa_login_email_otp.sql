-- Allow login-email OTP as last-resort MFA recovery (no authenticator / backup codes).
ALTER TABLE public.recovery_audit_log DROP CONSTRAINT IF EXISTS recovery_audit_log_method_check;
ALTER TABLE public.recovery_audit_log
  ADD CONSTRAINT recovery_audit_log_method_check
  CHECK (method IN ('backup_code', 'recovery_email', 'generate_codes', 'set_recovery_email', 'admin_reset', 'login_email_otp'));

ALTER TABLE public.mfa_recovery_tokens DROP CONSTRAINT IF EXISTS mfa_recovery_tokens_purpose_check;
ALTER TABLE public.mfa_recovery_tokens
  ADD CONSTRAINT mfa_recovery_tokens_purpose_check
  CHECK (purpose IN ('email_verify', 'mfa_reset', 'login_otp'));

CREATE OR REPLACE FUNCTION public.mfa_recovery_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_remaining INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF v_me.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT COUNT(*)::INTEGER INTO v_remaining
  FROM public.backup_codes WHERE user_id = v_uid AND used = false;

  RETURN jsonb_build_object(
    'remaining_codes', v_remaining,
    'codes_generated', v_me.backup_codes_generated_at IS NOT NULL,
    'codes_generated_at', v_me.backup_codes_generated_at,
    'login_email', CASE
      WHEN v_me.email IS NOT NULL THEN regexp_replace(v_me.email, '(^.).*(@.*$)', '\1***\2')
      ELSE NULL
    END,
    'recovery_email', CASE
      WHEN v_me.recovery_email_verified AND v_me.recovery_email IS NOT NULL THEN
        regexp_replace(v_me.recovery_email, '(^.).*(@.*$)', '\1***\2')
      ELSE NULL
    END,
    'recovery_email_verified', COALESCE(v_me.recovery_email_verified, false),
    'recovery_email_pending', CASE
      WHEN v_me.recovery_email_pending IS NOT NULL THEN
        regexp_replace(v_me.recovery_email_pending, '(^.).*(@.*$)', '\1***\2')
      ELSE NULL
    END,
    'low_codes', v_remaining > 0 AND v_remaining <= 3,
    'needs_codes', v_remaining = 0
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.mfa_recovery_status() TO authenticated;

NOTIFY pgrst, 'reload schema';
