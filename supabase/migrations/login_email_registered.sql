-- Used only to show a clearer login error. Does not return user records.

CREATE OR REPLACE FUNCTION public.login_email_registered(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE lower(u.email) = lower(trim(p_email))
  );
$$;

REVOKE ALL ON FUNCTION public.login_email_registered(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.login_email_registered(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.login_email_registered(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
