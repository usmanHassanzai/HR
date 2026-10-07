-- Rollback trusted devices MFA (apply only if needed)
-- Does NOT touch chaikhaata.

DROP FUNCTION IF EXISTS public.set_company_mfa_trust_policy(INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.get_company_mfa_trust_policy();
DROP FUNCTION IF EXISTS public.list_my_trusted_devices();
DROP FUNCTION IF EXISTS public.revoke_trusted_devices_for_user(UUID, TEXT);

DROP TABLE IF EXISTS public.trusted_devices;

ALTER TABLE public.companies
  DROP COLUMN IF EXISTS mfa_trust_staff_days,
  DROP COLUMN IF EXISTS mfa_trust_admin_days;

-- Restore prior recovery_audit_log method check (without trust_*)
ALTER TABLE public.recovery_audit_log DROP CONSTRAINT IF EXISTS recovery_audit_log_method_check;
ALTER TABLE public.recovery_audit_log
  ADD CONSTRAINT recovery_audit_log_method_check
  CHECK (method IN (
    'backup_code',
    'recovery_email',
    'generate_codes',
    'set_recovery_email',
    'admin_reset',
    'login_email_otp'
  ));

NOTIFY pgrst, 'reload schema';
