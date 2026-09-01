-- Login attempt audit, rate limits, and stop public email-enumeration RPC.

CREATE TABLE IF NOT EXISTS public.login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    event TEXT NOT NULL DEFAULT 'login',
    user_agent TEXT,
    ip TEXT,
    accepted_policy BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
    ON public.login_attempts (lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time
    ON public.login_attempts (ip, created_at DESC);

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.login_attempts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.request_client_ip()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    h JSONB;
    raw TEXT;
BEGIN
    BEGIN
        h := current_setting('request.headers', true)::jsonb;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
    raw := COALESCE(h->>'x-forwarded-for', h->>'x-real-ip', '');
    raw := NULLIF(trim(split_part(raw, ',', 1)), '');
    RETURN raw;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_login_attempt(
    p_email TEXT,
    p_success BOOLEAN,
    p_user_agent TEXT DEFAULT NULL,
    p_event TEXT DEFAULT 'login',
    p_accepted_policy BOOLEAN DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email TEXT := lower(trim(COALESCE(p_email, '')));
    v_event TEXT := lower(trim(COALESCE(p_event, 'login')));
BEGIN
    IF v_email = '' OR position('@' IN v_email) = 0 THEN
        RETURN;
    END IF;
    IF v_event NOT IN ('login', 'forgot') THEN
        v_event := 'login';
    END IF;
    INSERT INTO public.login_attempts (email, success, event, user_agent, ip, accepted_policy)
    VALUES (
        v_email,
        COALESCE(p_success, false),
        v_event,
        NULLIF(left(trim(COALESCE(p_user_agent, '')), 400), ''),
        public.request_client_ip(),
        p_accepted_policy
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.login_is_rate_limited(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email TEXT := lower(trim(COALESCE(p_email, '')));
    v_ip TEXT := public.request_client_ip();
    v_email_fails INTEGER := 0;
    v_ip_fails INTEGER := 0;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_email_fails
    FROM public.login_attempts
    WHERE lower(email) = v_email
      AND success = false
      AND event = 'login'
      AND created_at > timezone('utc'::text, now()) - INTERVAL '15 minutes';

    IF v_ip IS NOT NULL THEN
        SELECT COUNT(*)::INTEGER INTO v_ip_fails
        FROM public.login_attempts
        WHERE ip = v_ip
          AND success = false
          AND event = 'login'
          AND created_at > timezone('utc'::text, now()) - INTERVAL '15 minutes';
    END IF;

    RETURN v_email_fails >= 8 OR v_ip_fails >= 25;
END;
$$;

CREATE OR REPLACE FUNCTION public.forgot_is_rate_limited(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email TEXT := lower(trim(COALESCE(p_email, '')));
    v_n INTEGER := 0;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_n
    FROM public.login_attempts
    WHERE lower(email) = v_email
      AND event = 'forgot'
      AND created_at > timezone('utc'::text, now()) - INTERVAL '1 hour';
    RETURN v_n >= 4;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_login_attempts(p_limit INTEGER DEFAULT 200)
RETURNS TABLE (
    id UUID,
    email TEXT,
    success BOOLEAN,
    event TEXT,
    user_agent TEXT,
    ip TEXT,
    accepted_policy BOOLEAN,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role INTO v_role FROM public.users WHERE id = v_uid;
    IF v_role IS DISTINCT FROM 'admin'::public.user_role THEN
        RAISE EXCEPTION 'Only administrators can view login history';
    END IF;
    RETURN QUERY
    SELECT a.id, a.email, a.success, a.event, a.user_agent, a.ip, a.accepted_policy, a.created_at
    FROM public.login_attempts a
    WHERE a.email IN (
        SELECT lower(u.email) FROM public.users u
        WHERE public.can_access_user_data(u.id)
    )
    ORDER BY a.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
END;
$$;

DO $$
BEGIN
    REVOKE ALL ON FUNCTION public.login_email_registered(TEXT) FROM PUBLIC, anon, authenticated;
EXCEPTION WHEN undefined_function THEN
    NULL;
END $$;

GRANT EXECUTE ON FUNCTION public.request_client_ip() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_login_attempt(TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_is_rate_limited(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgot_is_rate_limited(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_login_attempts(INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
