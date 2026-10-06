-- office_network_upsert.sql
-- R67 / R74: extend upsert_office_location with Wi-Fi allowlist + detection mode;
-- company/user auto-attendance settings RPCs.

DROP FUNCTION IF EXISTS public.upsert_office_location(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN);

CREATE OR REPLACE FUNCTION public.upsert_office_location(
    p_id UUID,
    p_name TEXT,
    p_address TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INTEGER DEFAULT 150,
    p_active BOOLEAN DEFAULT true,
    p_wifi_ssids TEXT[] DEFAULT NULL,
    p_wifi_bssids TEXT[] DEFAULT NULL,
    p_public_ip_cidrs TEXT[] DEFAULT NULL,
    p_detection_mode TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_id UUID;
    v_demo BOOLEAN := public.is_demo_user(v_uid);
    v_company UUID;
    v_mode public.office_detection_mode;
BEGIN
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only admins can manage office locations';
    END IF;
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Office name is required';
    END IF;
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        RAISE EXCEPTION 'Latitude and longitude are required';
    END IF;

    IF p_detection_mode IS NULL OR btrim(p_detection_mode) = '' THEN
        v_mode := COALESCE(
          (SELECT detection_mode FROM public.office_locations WHERE id = p_id),
          'gps_or_wifi'::public.office_detection_mode
        );
    ELSE
        v_mode := p_detection_mode::public.office_detection_mode;
    END IF;

    IF p_public_ip_cidrs IS NOT NULL THEN
      PERFORM public.assert_public_ip_cidrs(p_public_ip_cidrs);
    END IF;

    IF NOT v_demo THEN
        v_company := public.current_company_id();
        IF v_company IS NULL THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.office_locations (
            name, address, latitude, longitude, radius_meters, active, is_demo, company_id,
            wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
        ) VALUES (
            trim(p_name),
            NULLIF(trim(p_address), ''),
            p_latitude,
            p_longitude,
            GREATEST(COALESCE(p_radius_meters, 150), 50),
            p_active,
            v_demo,
            v_company,
            COALESCE(p_wifi_ssids, '{}'),
            COALESCE(p_wifi_bssids, '{}'),
            COALESCE(p_public_ip_cidrs, '{}'),
            v_mode
        )
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.office_locations SET
            name = trim(p_name),
            address = NULLIF(trim(p_address), ''),
            latitude = p_latitude,
            longitude = p_longitude,
            radius_meters = GREATEST(COALESCE(p_radius_meters, 150), 50),
            active = p_active,
            wifi_ssids = COALESCE(p_wifi_ssids, wifi_ssids),
            wifi_bssids = COALESCE(p_wifi_bssids, wifi_bssids),
            public_ip_cidrs = COALESCE(p_public_ip_cidrs, public_ip_cidrs),
            detection_mode = v_mode,
            updated_at = timezone('utc'::text, now())
        WHERE id = p_id
          AND (
              (v_demo AND is_demo = true)
              OR (NOT v_demo AND company_id = v_company)
          )
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
    END IF;

    PERFORM public.sync_work_sites_to_office(v_id);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_company_auto_attendance(
  p_auto_phone BOOLEAN DEFAULT NULL,
  p_auto_laptop BOOLEAN DEFAULT NULL,
  p_timezone TEXT DEFAULT NULL
) RETURNS JSONB
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

  IF p_timezone IS NOT NULL THEN
    PERFORM public.assert_valid_iana_timezone(p_timezone);
  END IF;

  UPDATE public.companies SET
    auto_phone_attendance = COALESCE(p_auto_phone, auto_phone_attendance),
    auto_laptop_attendance = COALESCE(p_auto_laptop, auto_laptop_attendance),
    timezone = COALESCE(p_timezone, timezone)
  WHERE id = v_me.company_id;

  RETURN (
    SELECT jsonb_build_object(
      'auto_phone_attendance', c.auto_phone_attendance,
      'auto_laptop_attendance', c.auto_laptop_attendance,
      'timezone', c.timezone
    )
    FROM public.companies c WHERE c.id = v_me.company_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_user_auto_attendance(
  p_user_id UUID,
  p_auto_phone BOOLEAN DEFAULT NULL,
  p_auto_laptop BOOLEAN DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  IF v_me.id = p_user_id THEN
    NULL;
  ELSIF v_me.role IN ('admin', 'hr') AND v_me.company_id = v_target.company_id THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.users SET
    auto_phone_attendance = COALESCE(p_auto_phone, auto_phone_attendance),
    auto_laptop_attendance = COALESCE(p_auto_laptop, auto_laptop_attendance)
  WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_work_shift_timezone(
  p_shift_id UUID,
  p_timezone TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM public.assert_valid_iana_timezone(p_timezone);
  UPDATE public.work_shifts SET timezone = p_timezone WHERE id = p_shift_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_office_location(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN, TEXT[], TEXT[], TEXT[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_company_auto_attendance(BOOLEAN, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_auto_attendance(UUID, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_work_shift_timezone(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
