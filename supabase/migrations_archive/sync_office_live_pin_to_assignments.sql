-- When admin saves live office GPS, that pin becomes the check-in center for everyone
-- assigned to it. Attendance always reads coords from office_locations (not a stale copy).

CREATE OR REPLACE FUNCTION public.sync_work_sites_to_office(p_office_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_office public.office_locations%ROWTYPE;
    v_count INTEGER := 0;
    v_n INTEGER;
BEGIN
    SELECT * INTO v_office FROM public.office_locations WHERE id = p_office_id;
    IF NOT FOUND THEN RETURN 0; END IF;

    UPDATE public.manager_work_sites SET
        name = v_office.name,
        address = v_office.address,
        latitude = v_office.latitude,
        longitude = v_office.longitude,
        radius_meters = v_office.radius_meters,
        office_location_id = v_office.id,
        updated_at = timezone('utc'::text, now())
    WHERE office_location_id = p_office_id
       OR (office_location_id IS NULL AND lower(name) = lower(v_office.name));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + COALESCE(v_n, 0);

    UPDATE public.employee_work_sites SET
        name = v_office.name,
        address = v_office.address,
        latitude = v_office.latitude,
        longitude = v_office.longitude,
        radius_meters = v_office.radius_meters,
        office_location_id = v_office.id,
        updated_at = timezone('utc'::text, now())
    WHERE office_location_id = p_office_id
       OR (office_location_id IS NULL AND lower(name) = lower(v_office.name));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + COALESCE(v_n, 0);

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.upsert_office_location(
    p_id UUID,
    p_name TEXT,
    p_address TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INTEGER DEFAULT 150,
    p_active BOOLEAN DEFAULT true
) RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_id UUID;
    v_demo BOOLEAN := public.is_demo_user(v_uid);
    v_company UUID;
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

    IF NOT v_demo THEN
        v_company := public.current_company_id();
        IF v_company IS NULL THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.office_locations (
            name, address, latitude, longitude, radius_meters, active, is_demo, company_id
        ) VALUES (
            trim(p_name),
            NULLIF(trim(p_address), ''),
            p_latitude,
            p_longitude,
            GREATEST(COALESCE(p_radius_meters, 150), 50),
            p_active,
            v_demo,
            v_company
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
            updated_at = timezone('utc'::text, now())
        WHERE id = p_id
          AND (
              (v_demo AND is_demo = true)
              OR (NOT v_demo AND company_id = v_company)
          )
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
    END IF;

    -- Keep every assigned manager/employee site on this exact live pin
    PERFORM public.sync_work_sites_to_office(v_id);

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Attendance always uses the live office pin when linked
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
    v_user public.users%ROWTYPE;
    v_mgr UUID;
BEGIN
    SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RETURN; END IF;

    v_mgr := CASE
        WHEN v_user.role = 'manager'::public.user_role THEN v_user.id
        ELSE v_user.manager_id
    END;

    -- 0) Direct personal office assignment (coords from office row when linked)
    RETURN QUERY
    SELECT
        ews.id,
        COALESCE(o.name, ews.name),
        COALESCE(o.latitude, ews.latitude),
        COALESCE(o.longitude, ews.longitude),
        COALESCE(o.radius_meters, ews.radius_meters),
        ews.tracking_enabled,
        v_mgr
    FROM public.employee_work_sites ews
    LEFT JOIN public.office_locations o
      ON o.id = ews.office_location_id AND o.active = true
    WHERE ews.user_id = p_user_id
      AND ews.tracking_enabled = true
      AND ews.is_demo = v_user.is_demo
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- 1) Manager / self site (always prefer linked office pin)
    IF v_mgr IS NOT NULL THEN
        RETURN QUERY
        SELECT
            mws.id,
            COALESCE(o.name, mws.name),
            COALESCE(o.latitude, mws.latitude),
            COALESCE(o.longitude, mws.longitude),
            COALESCE(o.radius_meters, mws.radius_meters),
            mws.tracking_enabled,
            mws.manager_id
        FROM public.manager_work_sites mws
        LEFT JOIN public.office_locations o
          ON o.id = mws.office_location_id AND o.active = true
        WHERE mws.manager_id = v_mgr AND mws.tracking_enabled = true
        LIMIT 1;
        IF FOUND THEN RETURN; END IF;
    END IF;

    -- 2) Same department manager site
    RETURN QUERY
    SELECT
        mws.id,
        COALESCE(o.name, mws.name),
        COALESCE(o.latitude, mws.latitude),
        COALESCE(o.longitude, mws.longitude),
        COALESCE(o.radius_meters, mws.radius_meters),
        mws.tracking_enabled,
        mws.manager_id
    FROM public.manager_work_sites mws
    JOIN public.users m ON m.id = mws.manager_id
    LEFT JOIN public.office_locations o
      ON o.id = mws.office_location_id AND o.active = true
    WHERE mws.tracking_enabled = true
      AND m.role = 'manager'::public.user_role
      AND m.is_demo = v_user.is_demo
      AND v_user.department_id IS NOT NULL
      AND m.department_id = v_user.department_id
      AND (v_user.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM v_user.company_id)
    ORDER BY mws.updated_at DESC
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- 3) Any company manager site
    RETURN QUERY
    SELECT
        mws.id,
        COALESCE(o.name, mws.name),
        COALESCE(o.latitude, mws.latitude),
        COALESCE(o.longitude, mws.longitude),
        COALESCE(o.radius_meters, mws.radius_meters),
        mws.tracking_enabled,
        mws.manager_id
    FROM public.manager_work_sites mws
    JOIN public.users m ON m.id = mws.manager_id
    LEFT JOIN public.office_locations o
      ON o.id = mws.office_location_id AND o.active = true
    WHERE mws.tracking_enabled = true
      AND m.is_demo = v_user.is_demo
      AND (v_user.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM v_user.company_id)
    ORDER BY mws.updated_at DESC
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- 4) Company office location
    RETURN QUERY
    SELECT o.id, o.name, o.latitude, o.longitude, o.radius_meters, o.active, v_mgr
    FROM public.office_locations o
    WHERE o.active = true
      AND o.is_demo = v_user.is_demo
      AND (
          (v_user.is_demo = true AND o.company_id IS NULL)
          OR (v_user.company_id IS NOT NULL AND o.company_id = v_user.company_id)
      )
    ORDER BY o.updated_at DESC NULLS LAST, o.name
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Force assign RPCs to copy the office pin exactly (ignore stale client coords)
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
    v_radius INTEGER := COALESCE(p_radius_meters, 150);
    v_id UUID;
    v_office public.office_locations%ROWTYPE;
    v_mgr_role public.user_role;
    v_company UUID;
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

    IF NOT public.is_demo_user(v_caller) THEN
        IF NOT public.same_company(p_manager_id) THEN
            RAISE EXCEPTION 'Manager is not in your organization';
        END IF;
        v_company := public.current_company_id();
    END IF;

    IF p_office_location_id IS NOT NULL THEN
        SELECT * INTO v_office FROM public.office_locations
        WHERE id = p_office_location_id
          AND (
              (public.is_demo_user(v_caller) AND is_demo = true)
              OR (NOT public.is_demo_user(v_caller) AND company_id = v_company)
          );
        IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;
        -- Always use the saved live office pin
        v_lat := v_office.latitude;
        v_lng := v_office.longitude;
        v_name := v_office.name;
        v_address := v_office.address;
        v_radius := v_office.radius_meters;
    END IF;

    IF v_lat IS NULL OR v_lng IS NULL OR v_name IS NULL THEN
        RAISE EXCEPTION 'Location name and GPS coordinates are required';
    END IF;

    INSERT INTO public.manager_work_sites (
        manager_id, office_location_id, name, address, latitude, longitude,
        radius_meters, tracking_enabled, assigned_by, is_demo
    ) VALUES (
        p_manager_id, p_office_location_id, v_name, v_address, v_lat, v_lng,
        GREATEST(COALESCE(v_radius, 150), 50), COALESCE(p_tracking_enabled, true),
        v_caller, COALESCE(v_mgr_demo, false)
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

CREATE OR REPLACE FUNCTION public.assign_employee_work_site(
    p_user_id UUID,
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
    v_target_demo BOOLEAN;
    v_target_role public.user_role;
    v_lat DOUBLE PRECISION := p_latitude;
    v_lng DOUBLE PRECISION := p_longitude;
    v_name TEXT := NULLIF(trim(p_name), '');
    v_address TEXT := NULLIF(trim(p_address), '');
    v_radius INTEGER := COALESCE(p_radius_meters, 150);
    v_id UUID;
    v_office public.office_locations%ROWTYPE;
    v_company UUID;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NULL THEN RAISE EXCEPTION 'Employee is required'; END IF;

    IF NOT public.is_admin(v_caller) THEN
        RAISE EXCEPTION 'Only admins can assign employee office locations';
    END IF;

    SELECT role, is_demo INTO v_target_role, v_target_demo
    FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
    IF v_target_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        RAISE EXCEPTION 'Office GPS can only be assigned to employees or managers';
    END IF;

    PERFORM public.enforce_demo_isolation(p_user_id);

    IF NOT public.is_demo_user(v_caller) THEN
        IF NOT public.same_company(p_user_id) THEN
            RAISE EXCEPTION 'User is not in your organization';
        END IF;
        v_company := public.current_company_id();
    END IF;

    IF p_office_location_id IS NOT NULL THEN
        SELECT * INTO v_office FROM public.office_locations
        WHERE id = p_office_location_id
          AND (
              (public.is_demo_user(v_caller) AND is_demo = true)
              OR (NOT public.is_demo_user(v_caller) AND company_id = v_company)
          );
        IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;
        v_lat := v_office.latitude;
        v_lng := v_office.longitude;
        v_name := v_office.name;
        v_address := v_office.address;
        v_radius := v_office.radius_meters;
    END IF;

    IF v_lat IS NULL OR v_lng IS NULL OR v_name IS NULL THEN
        RAISE EXCEPTION 'Location name and GPS coordinates are required';
    END IF;

    INSERT INTO public.employee_work_sites (
        user_id, office_location_id, name, address, latitude, longitude,
        radius_meters, tracking_enabled, assigned_by, is_demo
    ) VALUES (
        p_user_id, p_office_location_id, v_name, v_address, v_lat, v_lng,
        GREATEST(COALESCE(v_radius, 150), 50), COALESCE(p_tracking_enabled, true),
        v_caller, COALESCE(v_target_demo, false)
    )
    ON CONFLICT (user_id) DO UPDATE SET
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

-- One-time sync all existing offices → assigned sites
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM public.office_locations WHERE active = true LOOP
        PERFORM public.sync_work_sites_to_office(r.id);
    END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.sync_work_sites_to_office(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_office_location(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_work_site_for_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_manager_work_site(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_employee_work_site(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;
