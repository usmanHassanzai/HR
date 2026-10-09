-- Rules 1 + 7: shared office Wi-Fi + GPS presence check for every path.
-- Check-in requires BOTH. Manual clock-out requires the same OR a usable
-- outside-radius reading. Mock locations rejected. Present rows need evidence.
-- Rule 5 outside auto check-out and Rule 6 closer are left intact.

-- ---------------------------------------------------------------------------
-- Shared presence check (IP from real request / edge-supplied trusted IP only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_office_presence_check(
  p_user_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision,
  p_is_mock boolean DEFAULT false,
  p_client_ip text DEFAULT NULL,
  p_mode text DEFAULT 'check_in'
)
RETURNS TABLE (
  ok boolean,
  reason text,
  on_wifi boolean,
  gps_usable boolean,
  inside_radius boolean,
  outside_radius boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ip text;
  v_on_wifi boolean := false;
  v_gps_usable boolean := false;
  v_inside boolean := false;
  v_outside boolean := false;
  v_mode text := lower(trim(COALESCE(p_mode, 'check_in')));
BEGIN
  IF p_user_id IS NULL THEN
    ok := false;
    reason := 'gps_unusable';
    on_wifi := false;
    gps_usable := false;
    inside_radius := false;
    outside_radius := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Trusted IP only: caller passes edge-derived IP, else PostgREST request headers.
  v_ip := NULLIF(btrim(COALESCE(p_client_ip, '')), '');
  IF v_ip IS NULL THEN
    v_ip := public.attendance_request_client_ip();
  END IF;

  IF COALESCE(p_is_mock, false) THEN
    ok := false;
    reason := 'gps_unusable';
    on_wifi := false;
    gps_usable := false;
    inside_radius := false;
    outside_radius := false;
    RETURN NEXT;
    RETURN;
  END IF;

  v_gps_usable :=
    p_lat IS NOT NULL
    AND p_lng IS NOT NULL
    AND p_accuracy IS NOT NULL
    AND p_accuracy <= 100;

  v_on_wifi := public.attendance_on_assigned_office_wifi(p_user_id, v_ip);

  IF v_gps_usable THEN
    v_inside := public.attendance_gps_inside_assigned_office(
      p_user_id, p_lat, p_lng, p_accuracy
    );
    v_outside := NOT v_inside;
  END IF;

  on_wifi := v_on_wifi;
  gps_usable := v_gps_usable;
  inside_radius := v_inside;
  outside_radius := v_outside;

  IF v_mode = 'check_out' THEN
    -- Same as check-in, OR already outside the radius with a usable reading.
    IF (v_on_wifi AND v_inside) OR v_outside THEN
      ok := true;
      reason := NULL;
    ELSIF NOT v_gps_usable THEN
      ok := false;
      reason := 'gps_unusable';
    ELSIF v_inside AND NOT v_on_wifi THEN
      ok := false;
      reason := 'not_on_office_wifi';
    ELSE
      ok := false;
      reason := 'outside_radius';
    END IF;
  ELSE
    -- check_in (default): BOTH wifi and inside radius.
    IF NOT v_gps_usable THEN
      ok := false;
      reason := 'gps_unusable';
    ELSIF NOT v_on_wifi THEN
      ok := false;
      reason := 'not_on_office_wifi';
    ELSIF NOT v_inside THEN
      ok := false;
      reason := 'outside_radius';
    ELSE
      ok := true;
      reason := NULL;
    END IF;
  END IF;

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_office_presence_check(
  uuid, double precision, double precision, double precision, boolean, text, text
) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Present-record evidence guard (system closers bypass via write mode)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_present_requires_presence_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_mode text := public.attendance_write_mode();
  v_opening boolean := false;
BEGIN
  IF v_mode IN ('shift_end_close', 'admin_correction', 'leave', 'day_status') THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'present'::public.attendance_status THEN
    RETURN NEW;
  END IF;
  IF NEW.clock_in_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_opening :=
    TG_OP = 'INSERT'
    OR OLD.clock_in_at IS DISTINCT FROM NEW.clock_in_at
    OR COALESCE(OLD.status::text, '') IS DISTINCT FROM 'present'
    OR (OLD.clock_out_at IS NOT NULL AND NEW.clock_out_at IS NULL);

  IF NOT v_opening THEN
    RETURN NEW;
  END IF;

  IF NEW.clock_in_lat IS NULL OR NEW.clock_in_lng IS NULL THEN
    RAISE EXCEPTION 'attendance_present_requires_wifi_and_gps: missing GPS on Present record';
  END IF;

  IF NEW.wifi_network_id IS NULL
     AND COALESCE(NEW.presence_method, '') NOT IN ('wifi', 'laptop') THEN
    RAISE EXCEPTION 'attendance_present_requires_wifi_and_gps: missing Wi-Fi match on Present record';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_present_requires_presence_evidence ON public.attendance_records;
CREATE TRIGGER trg_attendance_present_requires_presence_evidence
  BEFORE INSERT OR UPDATE OF status, clock_in_at, clock_out_at, clock_in_lat, clock_in_lng, wifi_network_id, presence_method
  ON public.attendance_records
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_present_requires_presence_evidence();

-- ---------------------------------------------------------------------------
-- Manual check-out: GPS required; wifi+inside OR usable outside
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.check_out_attendance(date);

CREATE OR REPLACE FUNCTION public.check_out_attendance(
  p_date date DEFAULT NULL,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy double precision DEFAULT NULL,
  p_is_mock boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
  v_win RECORD;
  v_shift_date DATE;
  v_rec public.attendance_records%ROWTYPE;
  v_total INTEGER := 0;
  v_id UUID;
  v_n INTEGER;
  v_chk RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    RAISE EXCEPTION 'attendance_outside_window: check-out only inside the attendance window';
  END IF;

  SELECT * INTO v_chk
  FROM public.attendance_office_presence_check(
    v_uid, p_latitude, p_longitude, p_accuracy, COALESCE(p_is_mock, false), NULL, 'check_out'
  )
  LIMIT 1;

  IF NOT COALESCE(v_chk.ok, false) THEN
    IF v_chk.reason = 'not_on_office_wifi' THEN
      RAISE EXCEPTION 'not_on_office_wifi: Connect to the office Wi-Fi';
    ELSIF v_chk.reason = 'gps_unusable' THEN
      RAISE EXCEPTION 'gps_unusable: Location unavailable, try again';
    ELSE
      RAISE EXCEPTION 'outside_radius: You are outside the office radius';
    END IF;
  END IF;

  v_shift_date := COALESCE(p_date, v_win.attendance_date);

  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_uid AND attendance_date = v_shift_date;

  IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
    RAISE EXCEPTION 'Check in first, then you can check out';
  END IF;
  IF v_rec.status = 'absent' THEN
    RAISE EXCEPTION 'Cannot check out on an absent day';
  END IF;
  IF v_rec.clock_out_at IS NOT NULL THEN
    RAISE EXCEPTION 'Already checked out';
  END IF;

  UPDATE public.attendance_visit_segments
  SET clock_out_at = v_now,
      clock_out_lat = COALESCE(p_latitude, clock_out_lat),
      clock_out_lng = COALESCE(p_longitude, clock_out_lng),
      work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - clock_in_at)) / 60)::INTEGER)
  WHERE user_id = v_uid
    AND attendance_date = v_shift_date
    AND clock_out_at IS NULL;

  IF NOT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments
    WHERE user_id = v_uid AND attendance_date = v_shift_date
  ) THEN
    SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
    FROM public.attendance_visit_segments
    WHERE user_id = v_uid AND attendance_date = v_shift_date;
    INSERT INTO public.attendance_visit_segments (
      user_id, attendance_record_id, attendance_date, visit_number,
      clock_in_at, clock_out_at, clock_out_lat, clock_out_lng, work_minutes, notes
    ) VALUES (
      v_uid, v_rec.id, v_shift_date, GREATEST(v_n, 1),
      v_rec.clock_in_at, v_now, p_latitude, p_longitude,
      GREATEST(0, (EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at)) / 60)::INTEGER),
      'Manual check-out'
    );
  END IF;

  v_total := public.attendance_day_total_minutes(v_uid, v_shift_date, v_now);

  UPDATE public.attendance_records
  SET clock_out_at = v_now,
      clock_out_lat = COALESCE(p_latitude, clock_out_lat),
      clock_out_lng = COALESCE(p_longitude, clock_out_lng),
      work_minutes = v_total
  WHERE id = v_rec.id
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_out_attendance(
  date, double precision, double precision, double precision, boolean
) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Patch process_geo_attendance_ping (add is_mock; shared check-in/out)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.process_geo_attendance_ping(
  double precision, double precision, double precision, text
);

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL,
  p_intent text DEFAULT 'auto',
  p_is_mock boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role public.user_role;
  v_inside BOOLEAN := false;
  v_rec public.attendance_records%ROWTYPE;
  v_has_rec BOOLEAN := false;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
  v_action TEXT := 'none';
  v_site_name TEXT;
  v_distance DOUBLE PRECISION;
  v_radius INTEGER;
  v_effective_radius DOUBLE PRECISION;
  v_work_site_id UUID;
  v_demo BOOLEAN;
  v_site_lat DOUBLE PRECISION;
  v_site_lng DOUBLE PRECISION;
  v_office_id UUID;
  v_office_dist DOUBLE PRECISION;
  v_win RECORD;
  v_visit public.attendance_visit_segments%ROWTYPE;
  v_has_visit BOOLEAN := false;
  v_seg_mins INTEGER;
  v_total_mins INTEGER;
  v_intent TEXT := lower(trim(COALESCE(p_intent, 'auto')));
  v_open_checkin BOOLEAN := false;
  v_prev_inside BOOLEAN;
  v_left_site BOOLEAN := false;
  v_attendance_date DATE;
  v_enrolled BOOLEAN := false;
  v_chk RECORD;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF COALESCE(p_is_mock, false) THEN
    RETURN jsonb_build_object('action', 'gps_unusable', 'reason', 'gps_unusable');
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
  IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees, managers, and HR only');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = v_user_id AND d.revoked_at IS NULL AND d.platform IN ('android', 'ios')
  ) INTO v_enrolled;

  UPDATE public.users SET last_seen_at = v_now WHERE id = v_user_id;

  IF v_intent NOT IN ('clock_in', 'clock_out', 'auto') THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'unknown_intent');
  END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_user_id, v_now) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    RETURN jsonb_build_object(
      'action', 'outside_window',
      'reason', 'outside_window',
      'window_start_utc', v_win.window_start_utc,
      'window_end_utc', v_win.window_end_utc
    );
  END IF;

  v_attendance_date := COALESCE(v_win.attendance_date, (v_now AT TIME ZONE COALESCE(v_win.shift_tz, v_win.company_tz, 'UTC'))::date);

  -- Nearest assigned office for distance / Rule 5 outside (unchanged thresholds).
  SELECT
    ews.office_location_id,
    o.name,
    o.latitude,
    o.longitude,
    COALESCE(o.radius_meters, 150),
    public.haversine_meters(p_latitude, p_longitude, o.latitude, o.longitude),
    COALESCE(o.is_demo, false)
  INTO v_office_id, v_site_name, v_site_lat, v_site_lng, v_radius, v_distance, v_demo
  FROM public.employee_work_sites ews
  JOIN public.office_locations o ON o.id = ews.office_location_id
  WHERE ews.user_id = v_user_id
    AND COALESCE(ews.tracking_enabled, true)
    AND COALESCE(o.active, true)
  ORDER BY public.haversine_meters(p_latitude, p_longitude, o.latitude, o.longitude) ASC
  LIMIT 1;

  v_work_site_id := v_office_id;
  v_effective_radius := COALESCE(v_radius, 150)::double precision;
  v_inside := v_distance IS NOT NULL AND v_distance <= v_effective_radius;

  SELECT inside_site INTO v_prev_inside
  FROM public.employee_location_pings
  WHERE user_id = v_user_id
  ORDER BY recorded_at DESC NULLS LAST
  LIMIT 1;

  v_left_site := p_accuracy IS NOT NULL
    AND p_accuracy <= 50
    AND v_distance IS NOT NULL
    AND v_distance > v_effective_radius
    AND public.geo_confirm_left_site(v_distance, v_effective_radius, v_prev_inside);

  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_user_id AND attendance_date = v_attendance_date
  LIMIT 1;
  v_open_checkin := v_rec.id IS NOT NULL;
  v_has_rec := v_open_checkin;

  SELECT * INTO v_visit
  FROM public.attendance_visit_segments vs
  WHERE vs.user_id = v_user_id
    AND vs.attendance_date = v_attendance_date
    AND vs.clock_out_at IS NULL
  ORDER BY vs.clock_in_at DESC
  LIMIT 1;
  v_has_visit := FOUND;

  INSERT INTO public.employee_location_pings (
    user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
  ) VALUES (
    v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
  );

  IF v_intent = 'clock_in' THEN
    IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_clocked_in';
    ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
      v_action := 'checkin_blocked_shift_ended';
    ELSE
      SELECT * INTO v_chk
      FROM public.attendance_office_presence_check(
        v_user_id, p_latitude, p_longitude, p_accuracy, false, NULL, 'check_in'
      ) LIMIT 1;
      IF NOT COALESCE(v_chk.ok, false) THEN
        v_action := COALESCE(v_chk.reason, 'outside_radius');
      ELSE
        INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, marked_by,
          clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
          reviewed_by, reviewed_at, presence_method
        ) VALUES (
          v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
          v_now, p_latitude, p_longitude, 'manual', v_win.shift_id,
          public.attendance_checkin_note(v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date),
          v_user_id, v_now, 'wifi'
        )
        ON CONFLICT (user_id, attendance_date) DO UPDATE SET
          clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
          clock_in_lat = COALESCE(EXCLUDED.clock_in_lat, public.attendance_records.clock_in_lat),
          clock_in_lng = COALESCE(EXCLUDED.clock_in_lng, public.attendance_records.clock_in_lng),
          clock_out_at = NULL,
          status = 'present',
          approval_status = 'approved',
          attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'manual' ELSE public.attendance_records.attendance_source END,
          presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
          shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
        RETURNING * INTO v_rec;
        PERFORM public.attendance_ensure_open_visit(
          v_user_id, v_rec.id, v_attendance_date, v_now, 'GPS entry'
        );
        v_action := 'clock_in';
      END IF;
    END IF;

  ELSIF v_intent = 'clock_out' THEN
    IF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
      v_action := 'no_open_visit';
    ELSIF v_rec.clock_out_at IS NOT NULL THEN
      v_action := 'already_clocked_out';
    ELSE
      SELECT * INTO v_chk
      FROM public.attendance_office_presence_check(
        v_user_id, p_latitude, p_longitude, p_accuracy, false, NULL, 'check_out'
      ) LIMIT 1;
      IF NOT COALESCE(v_chk.ok, false) THEN
        v_action := COALESCE(v_chk.reason, 'outside_radius');
      ELSE
        IF v_has_visit THEN
          v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
          UPDATE public.attendance_visit_segments SET
            clock_out_at = v_now,
            clock_out_lat = p_latitude,
            clock_out_lng = p_longitude,
            work_minutes = v_seg_mins
          WHERE id = v_visit.id;
        END IF;
        v_total_mins := public.attendance_day_total_minutes(v_user_id, v_attendance_date, v_now);
        UPDATE public.attendance_records SET
          clock_out_at = v_now,
          clock_out_lat = p_latitude,
          clock_out_lng = p_longitude,
          work_minutes = v_total_mins
        WHERE id = v_rec.id;
        v_action := 'clock_out';
      END IF;
    END IF;

  ELSIF v_intent = 'auto' THEN
    -- Rule 5: usable outside reading → immediate check-out (unchanged).
    IF v_left_site
       AND v_has_rec
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL
       AND v_now >= v_win.shift_start_utc
       AND v_now <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
      IF v_has_visit THEN
        v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
        UPDATE public.attendance_visit_segments SET
          clock_out_at = v_now,
          clock_out_lat = p_latitude,
          clock_out_lng = p_longitude,
          work_minutes = v_seg_mins,
          notes = COALESCE(notes, '') || ' | Auto leave (outside office radius)'
        WHERE id = v_visit.id;
      END IF;
      v_total_mins := public.attendance_day_total_minutes(v_user_id, v_attendance_date, v_now);
      UPDATE public.attendance_records SET
        clock_out_at = v_now,
        clock_out_lat = p_latitude,
        clock_out_lng = p_longitude,
        work_minutes = v_total_mins,
        notes = COALESCE(notes, '') || ' | Auto leave (outside office radius)'
      WHERE id = v_rec.id;
      UPDATE public.attendance_devices SET
        presence_state = 'left',
        gps_outside_streak = 0
      WHERE user_id = v_user_id AND revoked_at IS NULL;
      v_action := 'clock_out';
    ELSIF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
       AND public.attendance_checkin_allowed(v_user_id, v_now) THEN
      SELECT * INTO v_chk
      FROM public.attendance_office_presence_check(
        v_user_id, p_latitude, p_longitude, p_accuracy, false, NULL, 'check_in'
      ) LIMIT 1;
      IF NOT COALESCE(v_chk.ok, false) THEN
        v_action := COALESCE(v_chk.reason, 'outside_radius');
      ELSE
        INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, marked_by,
          clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
          reviewed_by, reviewed_at, presence_method
        ) VALUES (
          v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
          v_now, p_latitude, p_longitude, 'auto_wifi', v_win.shift_id,
          public.attendance_checkin_note(
            v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date
          ),
          v_user_id, v_now, 'wifi'
        )
        ON CONFLICT (user_id, attendance_date) DO UPDATE SET
          clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
          clock_in_lat = COALESCE(EXCLUDED.clock_in_lat, public.attendance_records.clock_in_lat),
          clock_in_lng = COALESCE(EXCLUDED.clock_in_lng, public.attendance_records.clock_in_lng),
          clock_out_at = NULL,
          status = 'present',
          approval_status = 'approved',
          attendance_source = CASE
            WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
            THEN 'auto_wifi' ELSE public.attendance_records.attendance_source END,
          presence_method = 'wifi',
          shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
        RETURNING * INTO v_rec;
        PERFORM public.attendance_ensure_open_visit(
          v_user_id, v_rec.id, v_attendance_date, v_now, 'Auto GPS entry'
        );
        v_action := 'clock_in';
      END IF;
    ELSIF v_inside AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_clocked_in';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'action', v_action,
    'reason', v_action,
    'inside_office', v_inside,
    'office_name', v_site_name,
    'distance_meters', v_distance,
    'radius_meters', v_radius,
    'effective_radius_meters', v_effective_radius,
    'accuracy_meters', p_accuracy,
    'window_start_utc', v_win.window_start_utc,
    'window_end_utc', v_win.window_end_utc,
    'shift_name', v_win.shift_name,
    'record_id', v_rec.id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(
  double precision, double precision, double precision, text, boolean
) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Patch process_auto_attendance_event: shared check for check-in only
-- (Rule 5 outside leave logic kept; zone wifi match kept for device presence)
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  def text;
  old_block text;
  new_block text;
BEGIN
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );

  -- Ensure mock rejection remains first (already present); reinforce reason.
  IF def NOT LIKE '%COALESCE(p_is_mock, false)%' AND def NOT LIKE '%p_is_mock%' THEN
    RAISE EXCEPTION 'auto event missing p_is_mock';
  END IF;

  old_block := $old$    ELSIF NOT v_wifi_ok THEN
      v_action := 'not_on_office_wifi';
    ELSIF NOT (
      v_gps_inside
      AND p_accuracy_m IS NOT NULL
      AND p_accuracy_m <= 100
    ) THEN
      v_action := CASE
        WHEN v_dev.platform IN ('windows', 'linux')
             AND NOT (
               p_latitude IS NOT NULL
               AND p_longitude IS NOT NULL
               AND p_accuracy_m IS NOT NULL
               AND p_accuracy_m <= 100
             )
          THEN 'need_fresh_location'
        ELSE 'outside_radius'
      END;
    ELSE
$old$;

  new_block := $new$    ELSE
      SELECT * INTO v_presence_chk
      FROM public.attendance_office_presence_check(
        v_dev.user_id, p_latitude, p_longitude, p_accuracy_m,
        COALESCE(p_is_mock, false), p_client_ip, 'check_in'
      ) LIMIT 1;
      IF NOT COALESCE(v_presence_chk.ok, false) THEN
        v_action := CASE
          WHEN v_presence_chk.reason = 'gps_unusable'
               AND v_dev.platform IN ('windows', 'linux')
            THEN 'need_fresh_location'
          ELSE COALESCE(v_presence_chk.reason, 'outside_radius')
        END;
      ELSE
$new$;

  IF position(old_block in def) = 0 THEN
    RAISE EXCEPTION 'auto check-in wifi/gps block not found for Rules 1+7 patch';
  END IF;

  def := replace(def, old_block, new_block);

  -- Close the extra IF introduced by shared check (after v_action := 'clock_in').
  IF position($old2$      v_action := 'clock_in';
    END IF;

  --------------------------------------------------------------------------
  -- LEFT → check-out
$old2$ in def) = 0 THEN
    RAISE EXCEPTION 'auto clock_in close block not found';
  END IF;

  def := replace(
    def,
    $old2$      v_action := 'clock_in';
    END IF;

  --------------------------------------------------------------------------
  -- LEFT → check-out
$old2$,
    $new2$      v_action := 'clock_in';
      END IF;
    END IF;

  --------------------------------------------------------------------------
  -- LEFT → check-out
$new2$
  );

  -- Declare v_presence_chk in the DECLARE section.
  IF def NOT LIKE '%v_presence_chk%' OR def LIKE '%v_presence_chk RECORD%' THEN
    NULL;
  END IF;
  IF position('v_presence_chk RECORD;' in def) = 0 THEN
    def := replace(
      def,
      'v_has_visit BOOLEAN := false;',
      'v_has_visit BOOLEAN := false;' || E'\n  v_presence_chk RECORD;'
    );
  END IF;

  EXECUTE def;
END;
$patch$;
