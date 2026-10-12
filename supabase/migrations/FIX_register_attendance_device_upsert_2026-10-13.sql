-- Re-enroll same device_id: unique (user_id, device_id) must UPDATE the
-- existing row instead of INSERT (which fails with duplicate key).

CREATE OR REPLACE FUNCTION public.register_attendance_device(
  p_device_id text,
  p_platform text,
  p_device_timezone text DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_token_plaintext text DEFAULT NULL
)
RETURNS jsonb
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

  -- Product: auto check-in platforms are Android + Desktop only.
  IF p_platform = 'ios' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'platform_disabled',
      'device_token', NULL,
      'message', 'Automatic check-in is not available on iOS yet. Use Android or the desktop app.'
    );
  END IF;
  IF p_platform = 'web' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'platform_disabled',
      'device_token', NULL,
      'message', 'Automatic check-in needs the Android app or desktop app (browser cannot stay enrolled in the background).'
    );
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

  IF p_platform = 'android' THEN
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

GRANT EXECUTE ON FUNCTION public.register_attendance_device(text, text, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
