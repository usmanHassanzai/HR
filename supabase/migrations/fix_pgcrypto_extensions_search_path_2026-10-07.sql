-- Hotfix: pgcrypto lives in schema `extensions` on Supabase.
-- SECURITY DEFINER functions with SET search_path = public cannot resolve
-- gen_random_bytes / digest / crypt / gen_salt unless extensions is on the path
-- or calls are schema-qualified.
--
-- Symptom: Android "Register this phone" → function gen_random_bytes(integer) does not exist

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Token hash helper (called from register_attendance_device + edge hashing paths)
CREATE OR REPLACE FUNCTION public.attendance_hash_device_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
$$;

-- Device enrollment (app calls via supabase.rpc('register_attendance_device', ...))
CREATE OR REPLACE FUNCTION public.register_attendance_device(
  p_device_id TEXT,
  p_platform TEXT,
  p_device_timezone TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_token_plaintext TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_token TEXT;
  v_hash TEXT;
  v_row public.attendance_devices%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_device_id IS NULL OR btrim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id required';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('android', 'ios', 'windows', 'linux', 'web') THEN
    RAISE EXCEPTION 'Invalid platform';
  END IF;

  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_token := COALESCE(
    NULLIF(btrim(p_token_plaintext), ''),
    encode(extensions.gen_random_bytes(32), 'hex')
  );
  v_hash := public.attendance_hash_device_token(v_token);

  -- Revoke prior row for same device_id
  UPDATE public.attendance_devices
  SET revoked_at = timezone('utc', now())
  WHERE user_id = v_uid AND device_id = btrim(p_device_id) AND revoked_at IS NULL;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, device_timezone, app_version, token_hash,
    created_at, last_seen_at
  ) VALUES (
    v_uid, v_me.company_id, btrim(p_device_id), p_platform,
    NULLIF(btrim(p_device_timezone), ''), NULLIF(btrim(p_app_version), ''),
    v_hash, timezone('utc', now()), timezone('utc', now())
  )
  RETURNING * INTO v_row;

  -- Enable per-user toggle for this platform family when registering
  IF p_platform IN ('android', 'ios') THEN
    UPDATE public.users SET auto_phone_attendance = true WHERE id = v_uid;
  ELSIF p_platform IN ('windows', 'linux') THEN
    UPDATE public.users SET auto_laptop_attendance = true WHERE id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'device_row_id', v_row.id,
    'device_token', v_token,
    'platform', p_platform
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_attendance_device(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_hash_device_token(TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
