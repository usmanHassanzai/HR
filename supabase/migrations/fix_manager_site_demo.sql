-- Fix manager work site demo flag + ensure demo manager has assigned site

-- Sites must use the MANAGER's demo flag, not the admin who assigned
UPDATE public.manager_work_sites mws
SET is_demo = u.is_demo,
    updated_at = timezone('utc'::text, now())
FROM public.users u
WHERE u.id = mws.manager_id
  AND mws.is_demo IS DISTINCT FROM u.is_demo;

CREATE OR REPLACE FUNCTION public.assign_manager_work_site(
    p_manager_id UUID,
    p_office_location_id UUID DEFAULT NULL,
    p_name TEXT DEFAULT NULL,
    p_address TEXT DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL,
    p_radius_meters INTEGER DEFAULT 150,
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
        COALESCE(p_radius_meters, 150), COALESCE(p_tracking_enabled, true), v_caller, COALESCE(v_mgr_demo, false)
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

-- Relax work-site lookup: demo managers can use their assigned site regardless of flag mismatch
CREATE OR REPLACE FUNCTION public.get_work_site_for_user(p_user_id UUID)
RETURNS TABLE(
    site_id UUID,
    site_name TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    radius_meters INTEGER,
    tracking_enabled BOOLEAN,
    manager_id UUID
) AS $$
DECLARE
    v_mgr UUID;
BEGIN
    SELECT CASE
        WHEN u.role = 'manager'::public.user_role THEN u.id
        ELSE u.manager_id
    END INTO v_mgr
    FROM public.users u
    WHERE u.id = p_user_id;

    IF v_mgr IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT
        mws.id,
        mws.name,
        mws.latitude,
        mws.longitude,
        mws.radius_meters,
        mws.tracking_enabled,
        mws.manager_id
    FROM public.manager_work_sites mws
    WHERE mws.manager_id = v_mgr
      AND mws.tracking_enabled = true
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Seed demo manager (Michael Scott) with Demo Office if missing
INSERT INTO public.manager_work_sites (
    manager_id, office_location_id, name, address, latitude, longitude,
    radius_meters, tracking_enabled, is_demo
)
SELECT
    u.id,
    o.id,
    o.name,
    o.address,
    o.latitude,
    o.longitude,
    o.radius_meters,
    true,
    true
FROM public.users u
CROSS JOIN public.office_locations o
WHERE u.email = 'manager@walfia.ai'
  AND o.name = 'Demo Office — HQ'
  AND o.is_demo = true
ON CONFLICT (manager_id) DO UPDATE SET
    office_location_id = EXCLUDED.office_location_id,
    name = EXCLUDED.name,
    address = EXCLUDED.address,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    radius_meters = EXCLUDED.radius_meters,
    tracking_enabled = true,
    is_demo = true,
    updated_at = timezone('utc'::text, now());
