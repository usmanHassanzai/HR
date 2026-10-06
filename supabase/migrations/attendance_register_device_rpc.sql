-- attendance_register_device_rpc.sql
-- R29 / E: register device (JWT once) → store token hash; revoke helpers

CREATE OR REPLACE FUNCTION public.register_attendance_device(
  p_device_id TEXT,
  p_platform TEXT,
  p_device_timezone TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_token_plaintext TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  v_token := COALESCE(NULLIF(btrim(p_token_plaintext), ''), encode(gen_random_bytes(32), 'hex'));
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

CREATE OR REPLACE FUNCTION public.revoke_attendance_device(p_device_row_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_dev public.attendance_devices%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  SELECT * INTO v_dev FROM public.attendance_devices WHERE id = p_device_row_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Device not found'; END IF;

  IF v_dev.user_id <> v_uid AND NOT (v_me.role IN ('admin', 'hr') AND v_me.company_id = v_dev.company_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.attendance_devices SET revoked_at = timezone('utc', now()) WHERE id = p_device_row_id;

  RETURN jsonb_build_object('ok', true, 'revoked', p_device_row_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.disable_my_auto_attendance(p_kind TEXT DEFAULT 'phone')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_kind = 'laptop' THEN
    UPDATE public.users SET auto_laptop_attendance = false WHERE id = v_uid;
    UPDATE public.attendance_devices SET revoked_at = timezone('utc', now())
    WHERE user_id = v_uid AND platform IN ('windows', 'linux') AND revoked_at IS NULL;
  ELSE
    UPDATE public.users SET auto_phone_attendance = false WHERE id = v_uid;
    UPDATE public.attendance_devices SET revoked_at = timezone('utc', now())
    WHERE user_id = v_uid AND platform IN ('android', 'ios') AND revoked_at IS NULL;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_company_attendance_devices()
RETURNS SETOF public.attendance_devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY
    SELECT d.* FROM public.attendance_devices d
    WHERE d.company_id = v_me.company_id
    ORDER BY d.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_unenrolled_auto_attendance_users()
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  email TEXT,
  role public.user_role,
  work_mode TEXT,
  phone_enabled BOOLEAN,
  laptop_enabled BOOLEAN,
  has_phone_device BOOLEAN,
  has_laptop_device BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.full_name,
    u.email,
    u.role,
    COALESCE(u.work_mode, 'office'),
    COALESCE(u.auto_phone_attendance, false),
    COALESCE(u.auto_laptop_attendance, false),
    EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform IN ('android', 'ios')
    ),
    EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform IN ('windows', 'linux')
    )
  FROM public.users u
  WHERE u.company_id = v_me.company_id
    AND u.role IN ('employee', 'manager', 'hr')
    AND COALESCE(u.work_mode, 'office') IN ('office', 'hybrid')
    AND (
      (COALESCE(u.auto_phone_attendance, false) AND NOT EXISTS (
        SELECT 1 FROM public.attendance_devices d
        WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform IN ('android', 'ios')
      ))
      OR (COALESCE(u.auto_laptop_attendance, false) AND NOT EXISTS (
        SELECT 1 FROM public.attendance_devices d
        WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform IN ('windows', 'linux')
      ))
      OR (
        NOT COALESCE(u.auto_phone_attendance, false)
        AND NOT COALESCE(u.auto_laptop_attendance, false)
      )
    )
  ORDER BY u.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_attendance_device(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_attendance_device(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.disable_my_auto_attendance(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_company_attendance_devices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_unenrolled_auto_attendance_users() TO authenticated;

NOTIFY pgrst, 'reload schema';
