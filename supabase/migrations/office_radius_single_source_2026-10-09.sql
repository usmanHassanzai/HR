-- Office table = single source of truth for pin, radius, active.
-- Assignment rows keep a synced read-only copy; list/profile/schedule read office live.
-- Re-runnable. Does not delete attendance_records or visit segments.

-- ---------------------------------------------------------------------------
-- office_version + keep assignment copies in sync
-- ---------------------------------------------------------------------------
ALTER TABLE public.office_locations
  ADD COLUMN IF NOT EXISTS office_version bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.sync_work_sites_to_office(p_office_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
$fn$;

CREATE OR REPLACE FUNCTION public.trg_office_locations_bump_and_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.office_version := COALESCE(NEW.office_version, 1);
    NEW.updated_at := timezone('utc'::text, now());
    RETURN NEW;
  END IF;

  IF NEW.latitude IS DISTINCT FROM OLD.latitude
     OR NEW.longitude IS DISTINCT FROM OLD.longitude
     OR NEW.radius_meters IS DISTINCT FROM OLD.radius_meters
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.address IS DISTINCT FROM OLD.address
     OR NEW.detection_mode IS DISTINCT FROM OLD.detection_mode THEN
    NEW.office_version := COALESCE(OLD.office_version, 1) + 1;
    NEW.updated_at := timezone('utc'::text, now());
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_office_locations_bump_version ON public.office_locations;
CREATE TRIGGER trg_office_locations_bump_version
  BEFORE INSERT OR UPDATE ON public.office_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_office_locations_bump_and_sync();

CREATE OR REPLACE FUNCTION public.trg_office_locations_after_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  PERFORM public.sync_work_sites_to_office(NEW.id);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_office_locations_after_sync ON public.office_locations;
CREATE TRIGGER trg_office_locations_after_sync
  AFTER INSERT OR UPDATE OF latitude, longitude, radius_meters, active, name, address, detection_mode
  ON public.office_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_office_locations_after_sync();

-- Backfill every linked assignment from its office now.
DO $backfill$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.office_locations LOOP
    PERFORM public.sync_work_sites_to_office(r.id);
  END LOOP;
END;
$backfill$;

-- ---------------------------------------------------------------------------
-- List RPCs: always show live office pin/radius when linked
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_employee_work_sites();
CREATE OR REPLACE FUNCTION public.get_employee_work_sites()
RETURNS TABLE(
  site_id UUID,
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  user_role public.user_role,
  site_name TEXT,
  site_address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  updated_at TIMESTAMPTZ,
  office_location_id UUID,
  office_version BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can view employee work sites';
  END IF;

  IF public.is_demo_user(v_uid) THEN
    RETURN QUERY
    SELECT
      ews.id,
      u.id,
      u.full_name,
      u.email,
      u.role,
      COALESCE(o.name, ews.name),
      COALESCE(o.address, ews.address),
      COALESCE(o.latitude, ews.latitude),
      COALESCE(o.longitude, ews.longitude),
      COALESCE(o.radius_meters, ews.radius_meters),
      ews.tracking_enabled,
      COALESCE(o.updated_at, ews.updated_at),
      ews.office_location_id,
      o.office_version
    FROM public.employee_work_sites ews
    JOIN public.users u ON u.id = ews.user_id
    LEFT JOIN public.office_locations o ON o.id = ews.office_location_id
    WHERE ews.is_demo = true
    ORDER BY u.full_name;
    RETURN;
  END IF;

  v_company := public.current_company_id();
  IF v_company IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    ews.id,
    u.id,
    u.full_name,
    u.email,
    u.role,
    COALESCE(o.name, ews.name),
    COALESCE(o.address, ews.address),
    COALESCE(o.latitude, ews.latitude),
    COALESCE(o.longitude, ews.longitude),
    COALESCE(o.radius_meters, ews.radius_meters),
    ews.tracking_enabled,
    COALESCE(o.updated_at, ews.updated_at),
    ews.office_location_id,
    o.office_version
  FROM public.employee_work_sites ews
  JOIN public.users u ON u.id = ews.user_id
  LEFT JOIN public.office_locations o ON o.id = ews.office_location_id
  WHERE u.company_id = v_company
    AND COALESCE(u.is_demo, false) = false
  ORDER BY u.full_name;
END;
$fn$;

DROP FUNCTION IF EXISTS public.get_manager_work_sites();
CREATE OR REPLACE FUNCTION public.get_manager_work_sites()
RETURNS TABLE(
  site_id UUID,
  manager_id UUID,
  manager_name TEXT,
  manager_email TEXT,
  team_count BIGINT,
  site_name TEXT,
  site_address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  updated_at TIMESTAMPTZ,
  office_location_id UUID,
  office_version BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can view manager work sites';
  END IF;

  IF public.is_demo_user(v_uid) THEN
    RETURN QUERY
    SELECT
      mws.id,
      m.id,
      m.full_name,
      m.email,
      (SELECT COUNT(*) FROM public.users e WHERE e.manager_id = m.id AND e.role = 'employee'::public.user_role),
      COALESCE(o.name, mws.name),
      COALESCE(o.address, mws.address),
      COALESCE(o.latitude, mws.latitude),
      COALESCE(o.longitude, mws.longitude),
      COALESCE(o.radius_meters, mws.radius_meters),
      mws.tracking_enabled,
      COALESCE(o.updated_at, mws.updated_at),
      mws.office_location_id,
      o.office_version
    FROM public.manager_work_sites mws
    JOIN public.users m ON m.id = mws.manager_id
    LEFT JOIN public.office_locations o ON o.id = mws.office_location_id
    WHERE mws.is_demo = true
    ORDER BY m.full_name;
    RETURN;
  END IF;

  v_company := public.current_company_id();
  IF v_company IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    mws.id,
    m.id,
    m.full_name,
    m.email,
    (SELECT COUNT(*) FROM public.users e WHERE e.manager_id = m.id AND e.role = 'employee'::public.user_role),
    COALESCE(o.name, mws.name),
    COALESCE(o.address, mws.address),
    COALESCE(o.latitude, mws.latitude),
    COALESCE(o.longitude, mws.longitude),
    COALESCE(o.radius_meters, mws.radius_meters),
    mws.tracking_enabled,
    COALESCE(o.updated_at, mws.updated_at),
    mws.office_location_id,
    o.office_version
  FROM public.manager_work_sites mws
  JOIN public.users m ON m.id = mws.manager_id
  LEFT JOIN public.office_locations o ON o.id = mws.office_location_id
  WHERE m.company_id = v_company
    AND m.is_demo = false
  ORDER BY m.full_name;
END;
$fn$;

-- Work site for user: office pin/radius when linked (personal override = ews row exists)
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
SET search_path TO 'public'
AS $fn$
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

  -- 0) Personal assignment (live office values when linked)
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

  -- 1) Manager / self site
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
$fn$;

-- GPS inside: office radius only
CREATE OR REPLACE FUNCTION public.attendance_gps_inside_assigned_office(
  p_user_id UUID,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_accuracy DOUBLE PRECISION
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.employee_work_sites ews
    JOIN public.office_locations o ON o.id = ews.office_location_id
    WHERE ews.user_id = p_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
      AND p_lat IS NOT NULL
      AND p_lng IS NOT NULL
      AND p_accuracy IS NOT NULL
      AND p_accuracy <= 100
      AND public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)
          <= COALESCE(o.radius_meters, 150)
  );
$$;

-- Profile / window: include live office radius + version
DROP FUNCTION IF EXISTS public.get_my_location_window();
CREATE OR REPLACE FUNCTION public.get_my_location_window()
RETURNS TABLE(
  source text,
  shift_name text,
  start_time time without time zone,
  end_time time without time zone,
  grace_minutes integer,
  days_of_week integer[],
  crosses_midnight boolean,
  in_window boolean,
  office_name text,
  latitude double precision,
  longitude double precision,
  radius_meters integer,
  office_version bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_win RECORD;
  v_grace INTEGER := 60;
  v_site RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_win
  FROM public.attendance_window_for_user(v_uid, timezone('utc'::text, now()))
  LIMIT 1;

  IF v_win.shift_id IS NOT NULL THEN
    SELECT COALESCE(ws.grace_minutes, 60) INTO v_grace
    FROM public.work_shifts ws
    WHERE ws.id = v_win.shift_id;
  ELSE
    v_grace := 60;
  END IF;

  SELECT * INTO v_site FROM public.get_work_site_for_user(v_uid) LIMIT 1;

  RETURN QUERY SELECT
    CASE WHEN v_win.shift_id IS NOT NULL THEN 'shift'::text ELSE 'company'::text END,
    v_win.shift_name,
    v_win.start_time,
    v_win.end_time,
    v_grace,
    COALESCE(v_win.days_of_week, ARRAY[1, 2, 3, 4, 5, 6, 7]),
    COALESCE(v_win.crosses_midnight, false),
    COALESCE(v_win.in_window, false),
    v_site.site_name,
    v_site.latitude,
    v_site.longitude,
    v_site.radius_meters,
    (
      SELECT o.office_version
      FROM public.employee_work_sites ews
      JOIN public.office_locations o ON o.id = ews.office_location_id
      WHERE ews.user_id = v_uid
      LIMIT 1
    );
END;
$fn$;

-- Device schedule: office radius + office_version
CREATE OR REPLACE FUNCTION public.attendance_schedule_for_user(
  p_user_id uuid,
  p_from timestamp with time zone DEFAULT timezone('utc'::text, now()),
  p_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_server_now TIMESTAMPTZ := timezone('utc', now());
  v_days JSONB := '[]'::JSONB;
  v_i INTEGER;
  v_at TIMESTAMPTZ;
  v_win RECORD;
  v_zone JSONB;
  v_user public.users%ROWTYPE;
  v_max_ver BIGINT := 0;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(z), '[]'::JSONB), COALESCE(MAX(ver), 0)
  INTO v_zone, v_max_ver
  FROM (
    SELECT jsonb_build_object(
      'zone_id', o.id,
      'name', o.name,
      'latitude', o.latitude,
      'longitude', o.longitude,
      'radius_meters', o.radius_meters,
      'office_version', o.office_version,
      'detection_mode', o.detection_mode,
      'wifi_ssids', o.wifi_ssids,
      'wifi_bssids', o.wifi_bssids
    ) AS z,
    o.office_version AS ver
    FROM public.office_locations o
    JOIN public.employee_work_sites ews ON ews.office_location_id = o.id
    WHERE ews.user_id = p_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
  ) q;

  FOR v_i IN 0..GREATEST(COALESCE(p_days, 7) - 1, 0) LOOP
    v_at := p_from + (v_i || ' days')::INTERVAL;
    SELECT * INTO v_win
    FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '12 hours')
    LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) THEN
      SELECT * INTO v_win
      FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '20 hours')
      LIMIT 1;
    END IF;
    IF NOT COALESCE(v_win.has_shift, false) THEN
      SELECT * INTO v_win
      FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '4 hours')
      LIMIT 1;
    END IF;

    IF COALESCE(v_win.has_shift, false) AND v_win.window_start_utc IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_days) e
        WHERE (e->>'attendance_date') = v_win.attendance_date::TEXT
      ) THEN
        v_days := v_days || jsonb_build_array(jsonb_build_object(
          'attendance_date', v_win.attendance_date,
          'shift_id', v_win.shift_id,
          'shift_name', v_win.shift_name,
          'shift_tz', v_win.shift_tz,
          'start_time', v_win.start_time,
          'end_time', v_win.end_time,
          'crosses_midnight', v_win.crosses_midnight,
          'shift_start_utc', v_win.shift_start_utc,
          'shift_end_utc', v_win.shift_end_utc,
          'window_start_utc', v_win.window_start_utc,
          'window_end_utc', v_win.window_end_utc
        ));
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'server_now_utc', v_server_now,
    'company_tz', public.company_timezone(v_user.company_id),
    'office_version', v_max_ver,
    'windows', v_days,
    'zones', COALESCE(v_zone, '[]'::JSONB)
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.sync_work_sites_to_office(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_work_sites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_manager_work_sites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_work_site_for_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_location_window() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_gps_inside_assigned_office(UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_schedule_for_user(UUID, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;

-- Realtime for web clients when office pin/radius changes
DO $rt$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.office_locations;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END;
$rt$;

NOTIFY pgrst, 'reload schema';
