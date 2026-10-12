-- Re-enroll same device_id after revoke/turn-off: unique (user_id, device_id)
-- must UPDATE the existing row instead of INSERT (which fails with duplicate key).

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
  v_device_id TEXT := btrim(p_device_id);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_device_id IS NULL OR v_device_id = '' THEN
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

  UPDATE public.attendance_devices
  SET
    platform = p_platform,
    device_timezone = COALESCE(NULLIF(btrim(p_device_timezone), ''), device_timezone),
    app_version = COALESCE(NULLIF(btrim(p_app_version), ''), app_version),
    token_hash = v_hash,
    revoked_at = NULL,
    last_seen_at = timezone('utc', now()),
    company_id = v_me.company_id
  WHERE user_id = v_uid AND device_id = v_device_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    INSERT INTO public.attendance_devices (
      user_id, company_id, device_id, platform, device_timezone, app_version, token_hash,
      created_at, last_seen_at
    ) VALUES (
      v_uid, v_me.company_id, v_device_id, p_platform,
      NULLIF(btrim(p_device_timezone), ''), NULLIF(btrim(p_app_version), ''),
      v_hash, timezone('utc', now()), timezone('utc', now())
    )
    RETURNING * INTO v_row;
  END IF;

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

NOTIFY pgrst, 'reload schema';
