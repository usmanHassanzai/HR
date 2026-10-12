CREATE OR REPLACE FUNCTION public.register_attendance_device(p_device_id text, p_platform text, p_device_timezone text DEFAULT NULL::text, p_app_version text DEFAULT NULL::text, p_token_plaintext text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
