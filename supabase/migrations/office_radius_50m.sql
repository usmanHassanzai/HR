-- Standard office check-in / GPS zone radius: 50 meters (was 150m).

ALTER TABLE public.office_locations
    ALTER COLUMN radius_meters SET DEFAULT 50;

ALTER TABLE public.manager_work_sites
    ALTER COLUMN radius_meters SET DEFAULT 50;

UPDATE public.office_locations
SET radius_meters = 50,
    updated_at = timezone('utc'::text, now())
WHERE radius_meters = 150;

UPDATE public.manager_work_sites
SET radius_meters = 50,
    updated_at = timezone('utc'::text, now())
WHERE radius_meters = 150;

CREATE OR REPLACE FUNCTION public.upsert_office_location(
    p_id UUID,
    p_name TEXT,
    p_address TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INTEGER DEFAULT 50,
    p_active BOOLEAN DEFAULT true
) RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_demo BOOLEAN := public.is_demo_user(auth.uid());
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins can manage office locations';
    END IF;
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Office name is required';
    END IF;
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        RAISE EXCEPTION 'Latitude and longitude are required';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.office_locations (name, address, latitude, longitude, radius_meters, active, is_demo)
        VALUES (trim(p_name), NULLIF(trim(p_address), ''), p_latitude, p_longitude, COALESCE(p_radius_meters, 50), p_active, v_demo)
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.office_locations SET
            name = trim(p_name),
            address = NULLIF(trim(p_address), ''),
            latitude = p_latitude,
            longitude = p_longitude,
            radius_meters = COALESCE(p_radius_meters, 50),
            active = p_active,
            updated_at = now()
        WHERE id = p_id
          AND (NOT v_demo OR is_demo = true)
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
    END IF;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.assign_manager_work_site(
    p_manager_id UUID,
    p_office_location_id UUID DEFAULT NULL,
    p_name TEXT DEFAULT NULL,
    p_address TEXT DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL,
    p_radius_meters INTEGER DEFAULT 50,
    p_tracking_enabled BOOLEAN DEFAULT true
) RETURNS UUID AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_mgr_demo BOOLEAN;
    v_lat DOUBLE PRECISION := p_latitude;
    v_lng DOUBLE PRECISION := p_longitude;
    v_name TEXT := NULLIF(trim(p_name), '');
    v_address TEXT := NULLIF(trim(p_address), '');
    v_id UUID;
    v_office public.office_locations%ROWTYPE;
    v_mgr_role public.user_role;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_caller) THEN
        RAISE EXCEPTION 'Only admins can assign manager work locations';
    END IF;
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'Manager is required'; END IF;

    SELECT role, is_demo INTO v_mgr_role, v_mgr_demo FROM public.users WHERE id = p_manager_id;
    IF v_mgr_role IS DISTINCT FROM 'manager'::public.user_role THEN
        RAISE EXCEPTION 'Work locations can only be assigned to managers';
    END IF;

    PERFORM public.enforce_demo_isolation(p_manager_id);

    IF p_office_location_id IS NOT NULL THEN
        SELECT * INTO v_office FROM public.office_locations
        WHERE id = p_office_location_id
          AND (NOT public.is_demo_user(v_caller) OR is_demo = true);
        IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;
        v_lat := v_office.latitude;
        v_lng := v_office.longitude;
        v_name := COALESCE(v_name, v_office.name);
        v_address := COALESCE(v_address, v_office.address);
    END IF;

    IF v_lat IS NULL OR v_lng IS NULL OR v_name IS NULL THEN
        RAISE EXCEPTION 'Location name and GPS coordinates are required';
    END IF;

    INSERT INTO public.manager_work_sites (
        manager_id, office_location_id, name, address, latitude, longitude,
        radius_meters, tracking_enabled, assigned_by, is_demo
    ) VALUES (
        p_manager_id, p_office_location_id, v_name, v_address, v_lat, v_lng,
        COALESCE(p_radius_meters, 50), COALESCE(p_tracking_enabled, true), v_caller, COALESCE(v_mgr_demo, false)
    )
    ON CONFLICT (manager_id) DO UPDATE SET
        office_location_id = EXCLUDED.office_location_id,
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        radius_meters = EXCLUDED.radius_meters,
        tracking_enabled = EXCLUDED.tracking_enabled,
        assigned_by = v_caller,
        is_demo = EXCLUDED.is_demo,
        updated_at = timezone('utc'::text, now())
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
