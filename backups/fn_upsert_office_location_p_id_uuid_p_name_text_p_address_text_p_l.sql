CREATE OR REPLACE FUNCTION public.upsert_office_location(p_id uuid, p_name text, p_address text, p_latitude double precision, p_longitude double precision, p_radius_meters integer DEFAULT 150, p_active boolean DEFAULT true, p_wifi_ssids text[] DEFAULT NULL::text[], p_wifi_bssids text[] DEFAULT NULL::text[], p_public_ip_cidrs text[] DEFAULT NULL::text[], p_detection_mode text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
