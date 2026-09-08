-- 2FA recovery: backup codes, recovery email, audit log, session grants

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS recovery_email TEXT,
  ADD COLUMN IF NOT EXISTS recovery_email_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_email_pending TEXT,
  ADD COLUMN IF NOT EXISTS backup_codes_generated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.backup_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_backup_codes_user_unused
  ON public.backup_codes (user_id)
  WHERE used = false;

CREATE TABLE IF NOT EXISTS public.recovery_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('backup_code', 'recovery_email', 'generate_codes', 'set_recovery_email', 'admin_reset', 'login_email_otp')),
  ip_address TEXT,
  success BOOLEAN NOT NULL DEFAULT false,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_recovery_audit_user
  ON public.recovery_audit_log (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.mfa_recovery_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verify', 'mfa_reset', 'login_otp')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_tokens_hash
  ON public.mfa_recovery_tokens (token_hash)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS public.mfa_session_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  method TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_mfa_session_grants_lookup
  ON public.mfa_session_grants (user_id, session_id, expires_at);

ALTER TABLE public.backup_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_session_grants ENABLE ROW LEVEL SECURITY;

-- No direct client writes; edge function uses service role.
REVOKE ALL ON public.backup_codes FROM anon, public, authenticated;
REVOKE ALL ON public.mfa_recovery_tokens FROM anon, public, authenticated;
REVOKE ALL ON public.mfa_session_grants FROM anon, public, authenticated;

GRANT SELECT ON public.recovery_audit_log TO authenticated;

DROP POLICY IF EXISTS recovery_audit_select ON public.recovery_audit_log;
CREATE POLICY recovery_audit_select ON public.recovery_audit_log
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (
      public.is_admin(auth.uid())
      AND user_id IN (
        SELECT u.id FROM public.users u
        WHERE u.company_id IS NOT DISTINCT FROM (
          SELECT me.company_id FROM public.users me WHERE me.id = auth.uid()
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION public.backup_codes_remaining(p_user_id UUID DEFAULT auth.uid())
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.backup_codes
  WHERE user_id = p_user_id AND used = false;
$$;

CREATE OR REPLACE FUNCTION public.has_mfa_session_grant(p_session_id TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_sid TEXT := NULLIF(trim(COALESCE(p_session_id, '')), '');
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;
  IF v_sid IS NULL THEN
    RETURN EXISTS (
      SELECT 1 FROM public.mfa_session_grants g
      WHERE g.user_id = v_uid AND g.expires_at > timezone('utc'::text, now())
    );
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.mfa_session_grants g
    WHERE g.user_id = v_uid
      AND g.session_id = v_sid
      AND g.expires_at > timezone('utc'::text, now())
  );
END;
$$;

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

GRANT EXECUTE ON FUNCTION public.backup_codes_remaining(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_mfa_session_grant(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mfa_recovery_status() TO authenticated;

NOTIFY pgrst, 'reload schema';
