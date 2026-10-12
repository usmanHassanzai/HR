-- office_radius_all_employees_2026-10-12.sql
-- Make office radius_meters apply to every assigned employee (and org fallback).
-- Restores pin/radius sync to work-site copies + live office radius on reads.
-- Minimal GPS presence check (inside/outside radius) without restoring auto-attendance writes.

-- ---------------------------------------------------------------------------
-- 1) Propagate office pin + radius to everyone assigned to that office
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_work_sites_to_office(p_office_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.sync_work_sites_to_office(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) Upsert office: save + sync radius/pin to all assigned people
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_office_location(
  p_id uuid,
  p_name text,
  p_address text,
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters integer DEFAULT 150,
  p_active boolean DEFAULT true,
  p_wifi_ssids text[] DEFAULT NULL,
  p_wifi_bssids text[] DEFAULT NULL,
  p_public_ip_cidrs text[] DEFAULT NULL,
  p_detection_mode text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id UUID;
  v_demo BOOLEAN := public.is_demo_user(v_uid);
  v_company UUID;
  v_mode text;
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

  v_mode := COALESCE(NULLIF(btrim(p_detection_mode), ''), 'gps_or_wifi');

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
      GREATEST(COALESCE(p_radius_meters, 150), 1),
      p_active,
      v_demo,
      v_company,
      COALESCE(p_wifi_ssids, '{}'),
      COALESCE(p_wifi_bssids, '{}'),
      COALESCE(p_public_ip_cidrs, '{}'),
      v_mode::public.office_detection_mode
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.office_locations SET
      name = trim(p_name),
      address = NULLIF(trim(p_address), ''),
      latitude = p_latitude,
      longitude = p_longitude,
      radius_meters = GREATEST(COALESCE(p_radius_meters, 150), 1),
      active = p_active,
      wifi_ssids = COALESCE(p_wifi_ssids, wifi_ssids),
      wifi_bssids = COALESCE(p_wifi_bssids, wifi_bssids),
      public_ip_cidrs = COALESCE(p_public_ip_cidrs, public_ip_cidrs),
      detection_mode = v_mode::public.office_detection_mode,
      updated_at = timezone('utc'::text, now())
    WHERE id = p_id
      AND (
        (v_demo AND is_demo = true)
        OR (NOT v_demo AND company_id = v_company)
      )
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
  END IF;

  -- Keep every assigned employee/manager work-site copy on this office's live pin + radius.
  PERFORM public.sync_work_sites_to_office(v_id);

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_office_location(uuid, text, text, double precision, double precision, integer, boolean, text[], text[], text[], text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) Resolve work site for any employee: personal → manager → company office
--    Always prefer live office_locations.radius_meters when linked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_work_site_for_user(p_user_id UUID)
RETURNS TABLE(
  site_id UUID,
  site_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  manager_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- 0) Personal office assignment (live pin + radius from office_locations)
  RETURN QUERY
  SELECT
    ews.id,
    COALESCE(o.name, ews.name),
    COALESCE(o.latitude, ews.latitude),
    COALESCE(o.longitude, ews.longitude),
    COALESCE(o.radius_meters, ews.radius_meters, 150),
    ews.tracking_enabled,
    v_mgr
  FROM public.employee_work_sites ews
  LEFT JOIN public.office_locations o
    ON o.id = ews.office_location_id
   AND COALESCE(o.active, true) = true
   AND o.is_demo = v_user.is_demo
  WHERE ews.user_id = p_user_id
    AND ews.tracking_enabled = true
    AND ews.is_demo = v_user.is_demo
  LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- 1) Assigned manager / self team site (live pin + radius when linked)
  IF v_mgr IS NOT NULL THEN
    RETURN QUERY
    SELECT
      mws.id,
      COALESCE(o.name, mws.name),
      COALESCE(o.latitude, mws.latitude),
      COALESCE(o.longitude, mws.longitude),
      COALESCE(o.radius_meters, mws.radius_meters, 150),
      mws.tracking_enabled,
      mws.manager_id
    FROM public.manager_work_sites mws
    LEFT JOIN public.office_locations o
      ON o.id = mws.office_location_id
     AND COALESCE(o.active, true) = true
     AND o.is_demo = v_user.is_demo
    WHERE mws.manager_id = v_mgr
      AND mws.tracking_enabled = true
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- 2) Any manager in the same department
  RETURN QUERY
  SELECT
    mws.id,
    COALESCE(o.name, mws.name),
    COALESCE(o.latitude, mws.latitude),
    COALESCE(o.longitude, mws.longitude),
    COALESCE(o.radius_meters, mws.radius_meters, 150),
    mws.tracking_enabled,
    mws.manager_id
  FROM public.manager_work_sites mws
  JOIN public.users m ON m.id = mws.manager_id
  LEFT JOIN public.office_locations o
    ON o.id = mws.office_location_id
   AND COALESCE(o.active, true) = true
   AND o.is_demo = v_user.is_demo
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
    COALESCE(o.radius_meters, mws.radius_meters, 150),
    mws.tracking_enabled,
    mws.manager_id
  FROM public.manager_work_sites mws
  JOIN public.users m ON m.id = mws.manager_id
  LEFT JOIN public.office_locations o
    ON o.id = mws.office_location_id
   AND COALESCE(o.active, true) = true
   AND o.is_demo = v_user.is_demo
  WHERE mws.tracking_enabled = true
    AND m.is_demo = v_user.is_demo
    AND (v_user.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM v_user.company_id)
  ORDER BY mws.updated_at DESC
  LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- 4) Org-wide active office (covers employees with no personal/manager assignment)
  RETURN QUERY
  SELECT
    o.id,
    o.name,
    o.latitude,
    o.longitude,
    COALESCE(o.radius_meters, 150),
    o.active,
    v_mgr
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
$$;

GRANT EXECUTE ON FUNCTION public.get_work_site_for_user(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_work_site()
RETURNS TABLE(
  site_id UUID,
  site_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  manager_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY SELECT * FROM public.get_work_site_for_user(auth.uid());
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_work_site() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4) Minimal office-radius presence check (no attendance writes / auto rules)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role public.user_role;
  v_site RECORD;
  v_distance DOUBLE PRECISION;
  v_radius INTEGER;
  v_inside BOOLEAN := false;
  v_action TEXT := 'outside_office';
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
  IF v_role NOT IN (
    'employee'::public.user_role,
    'manager'::public.user_role,
    'hr'::public.user_role
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'rules_not_configured',
      'action', 'skipped',
      'reason', 'Geo attendance is for employees, managers, and HR only',
      'message', 'Attendance writes are paused. Office radius checks apply to employees, managers, and HR.'
    );
  END IF;

  SELECT * INTO v_site FROM public.get_work_site_for_user(v_user_id) LIMIT 1;

  IF v_site.site_id IS NULL OR v_site.latitude IS NULL OR v_site.longitude IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'rules_not_configured',
      'action', 'outside_office',
      'reason', 'no_work_site',
      'inside_office', false,
      'message', 'No office zone assigned. Ask admin: Office & Attendance → Assign people (or Assign to all). Attendance writes remain paused.'
    );
  END IF;

  v_radius := GREATEST(COALESCE(v_site.radius_meters, 150), 1);
  v_distance := public.haversine_meters(p_latitude, p_longitude, v_site.latitude, v_site.longitude);
  v_inside := v_distance IS NOT NULL AND v_distance <= v_radius;
  v_action := CASE WHEN v_inside THEN 'inside_office' ELSE 'outside_radius' END;

  RETURN jsonb_build_object(
    'ok', false,
    'status', 'rules_not_configured',
    'action', v_action,
    'reason', 'rules_not_configured',
    'inside_office', v_inside,
    'office_name', v_site.site_name,
    'distance_meters', ROUND(v_distance)::integer,
    'radius_meters', v_radius,
    'effective_radius_meters', v_radius,
    'message', CASE
      WHEN v_inside THEN
        'Inside office radius (' || v_radius || 'm). Attendance check-in/out writes are still paused while rules are rebuilt.'
      ELSE
        'Outside office radius (' || v_radius || 'm). Attendance check-in/out writes are still paused while rules are rebuilt.'
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.process_geo_attendance_ping(p_latitude, p_longitude, p_accuracy);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text,
  p_is_mock boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(p_is_mock, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'rules_not_configured',
      'action', 'gps_unusable',
      'reason', 'gps_unusable',
      'inside_office', false,
      'message', 'Mock location is not allowed for office radius checks. Attendance writes remain paused.'
    );
  END IF;
  RETURN public.process_geo_attendance_ping(p_latitude, p_longitude, p_accuracy);
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean) TO authenticated;

-- Backfill: sync every existing office so current assignments get live radius
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.office_locations LOOP
    PERFORM public.sync_work_sites_to_office(r.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
