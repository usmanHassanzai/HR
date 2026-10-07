-- Trusted devices for MFA skip (7-day default, company policy, audit)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Company MFA trust policy (days; 0 = always ask)
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS mfa_trust_staff_days INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS mfa_trust_admin_days INTEGER NOT NULL DEFAULT 7;

DO $$
BEGIN
  ALTER TABLE public.companies
    DROP CONSTRAINT IF EXISTS companies_mfa_trust_staff_days_check;
  ALTER TABLE public.companies
    ADD CONSTRAINT companies_mfa_trust_staff_days_check
    CHECK (mfa_trust_staff_days IN (0, 1, 7, 14, 30));

  ALTER TABLE public.companies
    DROP CONSTRAINT IF EXISTS companies_mfa_trust_admin_days_check;
  ALTER TABLE public.companies
    ADD CONSTRAINT companies_mfa_trust_admin_days_check
    CHECK (mfa_trust_admin_days IN (0, 1, 7));
EXCEPTION
  WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

-- Allow re-trust after revoke: only one *active* row per device
ALTER TABLE public.trusted_devices DROP CONSTRAINT IF EXISTS trusted_devices_user_id_device_id_key;
DROP INDEX IF EXISTS trusted_devices_user_id_device_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_user_device_active_uidx
  ON public.trusted_devices (user_id, device_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trusted_devices_token
  ON public.trusted_devices (token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user
  ON public.trusted_devices (user_id, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE public.trusted_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trusted_devices FROM anon, public, authenticated;

-- Expand recovery_audit_log methods for trust events
ALTER TABLE public.recovery_audit_log DROP CONSTRAINT IF EXISTS recovery_audit_log_method_check;
ALTER TABLE public.recovery_audit_log
  ADD CONSTRAINT recovery_audit_log_method_check
  CHECK (method IN (
    'backup_code',
    'recovery_email',
    'generate_codes',
    'set_recovery_email',
    'admin_reset',
    'login_email_otp',
    'trust_created',
    'trust_used',
    'trust_revoked'
  ));

CREATE OR REPLACE FUNCTION public.revoke_trusted_devices_for_user(p_user_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE public.trusted_devices
  SET revoked_at = timezone('utc'::text, now())
  WHERE user_id = p_user_id
    AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO public.recovery_audit_log (user_id, method, success, detail)
    VALUES (
      p_user_id,
      'trust_revoked',
      true,
      COALESCE(p_reason, 'revoked') || ' (' || n::text || ' device(s))'
    );
  END IF;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_trusted_devices_for_user(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_trusted_devices_for_user(UUID, TEXT) TO service_role;

-- Own-device list (no token hashes)
CREATE OR REPLACE FUNCTION public.list_my_trusted_devices()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.last_used_at DESC NULLS LAST, t.created_at DESC)
    FROM (
      SELECT
        id,
        device_id,
        platform,
        label,
        user_agent,
        created_at,
        expires_at,
        last_used_at,
        (revoked_at IS NOT NULL OR expires_at <= timezone('utc'::text, now())) AS inactive
      FROM public.trusted_devices
      WHERE user_id = v_uid
        AND revoked_at IS NULL
        AND expires_at > timezone('utc'::text, now())
    ) t
  ), '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_trusted_devices() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_company_mfa_trust_policy()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_co public.companies%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF v_me.company_id IS NULL THEN
    RETURN jsonb_build_object(
      'mfa_trust_staff_days', 7,
      'mfa_trust_admin_days', 7,
      'can_edit', false
    );
  END IF;
  SELECT * INTO v_co FROM public.companies WHERE id = v_me.company_id;
  RETURN jsonb_build_object(
    'mfa_trust_staff_days', COALESCE(v_co.mfa_trust_staff_days, 7),
    'mfa_trust_admin_days', COALESCE(v_co.mfa_trust_admin_days, 7),
    'can_edit', (v_me.role IN ('admin', 'hr') AND COALESCE(v_me.is_demo, false) = false)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_company_mfa_trust_policy() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_company_mfa_trust_policy(
  p_staff_days INTEGER,
  p_admin_days INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF v_me.company_id IS NULL OR v_me.role NOT IN ('admin', 'hr') OR COALESCE(v_me.is_demo, false) THEN
    RAISE EXCEPTION 'Only company admin or HR can change MFA trust policy';
  END IF;
  IF p_staff_days NOT IN (0, 1, 7, 14, 30) THEN
    RAISE EXCEPTION 'Invalid staff trust days';
  END IF;
  IF p_admin_days NOT IN (0, 1, 7) THEN
    RAISE EXCEPTION 'Invalid admin/HR trust days';
  END IF;
  UPDATE public.companies
  SET
    mfa_trust_staff_days = p_staff_days,
    mfa_trust_admin_days = p_admin_days
  WHERE id = v_me.company_id;
  RETURN jsonb_build_object(
    'ok', true,
    'mfa_trust_staff_days', p_staff_days,
    'mfa_trust_admin_days', p_admin_days
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_company_mfa_trust_policy(INTEGER, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
