-- Re-entry check-in. Re-runnable. LAST in apply-all-migrations.mjs.
-- 1) Shared check-in helper used by device-token + dashboard paths.
-- 2) outside_window / clock_out must not revoke device tokens.
-- 3) After check-out, never short-circuit with duplicate_ignored.
-- 4) already_checked_in only when an open visit exists.
-- 5) "Checked in again at <time>" on re-entry.

CREATE OR REPLACE FUNCTION public.attendance_try_auto_checkin(
  p_user_id uuid,
  p_occurred_at timestamptz,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL,
  p_is_mock boolean DEFAULT false,
  p_client_ip text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_zone_name text DEFAULT NULL,
  p_wifi_network_id uuid DEFAULT NULL,
  p_wifi_network_label text DEFAULT NULL,
  p_distance_m double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_at timestamptz := COALESCE(p_occurred_at, v_now);
  v_att_date date;
  v_win RECORD;
  v_presence RECORD;
  v_rec public.attendance_records%ROWTYPE;
  v_has_visit boolean := false;
  v_method text;
  v_source text;
  v_note text;
  v_prior_closed boolean := false;
  v_local text;
  v_company uuid;
  v_platform text := lower(COALESCE(p_platform, ''));
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'action', 'none', 'reason', 'missing_user');
  END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(p_user_id, v_at) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'checkin_blocked_shift_ended',
      'reason', 'outside_window',
      'stop_tracking', false
    );
  END IF;

  IF NOT public.attendance_checkin_allowed(p_user_id, v_at) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'checkin_blocked_shift_ended',
      'reason', 'checkin_blocked_shift_ended',
      'stop_tracking', false
    );
  END IF;

  v_att_date := COALESCE(
    v_win.attendance_date,
    public.resolve_shift_attendance_date(p_user_id, v_at)
  );

  IF public.attendance_is_wfh_day(p_user_id, v_att_date) THEN
    RETURN jsonb_build_object('ok', true, 'action', 'wfh_skip', 'reason', 'wfh_skip');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND vs.clock_out_at IS NULL
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
  ) INTO v_has_visit;
  IF v_has_visit THEN
    RETURN jsonb_build_object('ok', true, 'action', 'already_checked_in', 'reason', 'already_checked_in');
  END IF;

  SELECT * INTO v_presence
  FROM public.attendance_office_presence_check(
    p_user_id, p_latitude, p_longitude, p_accuracy_m,
    COALESCE(p_is_mock, false), p_client_ip, 'check_in'
  ) LIMIT 1;

  IF NOT COALESCE(v_presence.ok, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', COALESCE(v_presence.reason, 'outside_radius'),
      'reason', COALESCE(v_presence.reason, 'outside_radius'),
      'stop_tracking', false
    );
  END IF;

  IF COALESCE(v_presence.match_kind, '') = 'wifi_no_gps'
     OR (COALESCE(v_presence.on_wifi, false) AND NOT COALESCE(v_presence.gps_usable, false)) THEN
    v_method := CASE WHEN v_platform IN ('windows', 'linux') THEN 'laptop' ELSE 'wifi' END;
    v_source := 'auto_wifi_no_gps';
  ELSE
    v_method := CASE WHEN v_platform IN ('windows', 'linux') THEN 'laptop' ELSE 'wifi' END;
    v_source := CASE WHEN v_platform IN ('windows', 'linux') THEN 'auto_laptop' ELSE 'auto_wifi' END;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND vs.attendance_date = v_att_date
      AND vs.clock_out_at IS NOT NULL
  ) INTO v_prior_closed;

  IF v_source = 'auto_wifi_no_gps' THEN
    v_note := 'Checked in on office Wi-Fi, location unavailable'
      || CASE WHEN p_wifi_network_label IS NOT NULL THEN ' · ' || p_wifi_network_label ELSE '' END;
  ELSE
    v_note := 'Checked in at ' || COALESCE(p_zone_name, 'office')
      || ' · ' || COALESCE(p_wifi_network_label, 'office Wi-Fi')
      || CASE
           WHEN COALESCE(v_presence.distance_m, p_distance_m) IS NOT NULL
           THEN ' · ' || ROUND(COALESCE(v_presence.distance_m, p_distance_m))::int || 'm from the office'
           ELSE ''
         END;
  END IF;

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, marked_by,
    clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
    reviewed_by, reviewed_at, presence_method, wifi_network_id, wifi_network_label
  ) VALUES (
    p_user_id, v_att_date, 'present', 'approved', p_user_id,
    v_at, p_latitude, p_longitude, v_source, v_win.shift_id, v_note,
    p_user_id, v_now, v_method, p_wifi_network_id, p_wifi_network_label
  )
  ON CONFLICT (user_id, attendance_date) DO UPDATE SET
    clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
    clock_out_at = NULL,
    clock_out_lat = NULL,
    clock_out_lng = NULL,
    status = 'present',
    approval_status = 'approved',
    attendance_source = CASE
      WHEN public.attendance_records.clock_in_at IS NULL OR public.attendance_records.clock_out_at IS NOT NULL
      THEN EXCLUDED.attendance_source
      ELSE public.attendance_records.attendance_source
    END,
    presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
    wifi_network_id = COALESCE(EXCLUDED.wifi_network_id, public.attendance_records.wifi_network_id),
    wifi_network_label = COALESCE(EXCLUDED.wifi_network_label, public.attendance_records.wifi_network_label),
    shift_id = COALESCE(EXCLUDED.shift_id, public.attendance_records.shift_id),
    notes = CASE
      WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
      THEN EXCLUDED.notes ELSE public.attendance_records.notes
    END
  RETURNING * INTO v_rec;

  PERFORM public.attendance_ensure_open_visit(
    p_user_id, v_rec.id, v_att_date, v_at,
    'Auto entry ' || COALESCE(v_method, '')
  );

  UPDATE public.attendance_visit_segments SET
    clock_in_lat = COALESCE(clock_in_lat, p_latitude),
    clock_in_lng = COALESCE(clock_in_lng, p_longitude),
    site_name = COALESCE(site_name, p_zone_name),
    wifi_network_id = COALESCE(p_wifi_network_id, wifi_network_id),
    wifi_network_label = COALESCE(p_wifi_network_label, wifi_network_label)
  WHERE user_id = p_user_id
    AND attendance_date = v_att_date
    AND clock_out_at IS NULL;

  UPDATE public.attendance_devices SET
    presence_state = 'present',
    last_presence_at = v_at,
    gps_outside_streak = 0
  WHERE user_id = p_user_id
    AND revoked_at IS NULL;

  PERFORM public.attendance_touch_user_signals(
    p_user_id, v_at, true, COALESCE(v_presence.inside_radius, false)
  );

  SELECT company_id INTO v_company FROM public.users WHERE id = p_user_id;
  v_local := to_char(
    timezone(COALESCE(public.company_timezone(v_company), 'UTC'), v_at),
    'HH12:MI AM'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'clock_in',
    'reason', 'clock_in',
    'attendance_date', v_att_date,
    'attendance_source', v_source,
    'presence_method', v_method,
    'local_time', v_local,
    'notify_message', CASE
      WHEN v_prior_closed THEN format('Checked in again at %s', v_local)
      ELSE format('Checked in at %s', v_local)
    END,
    'stop_tracking', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_try_auto_checkin(
  uuid, timestamptz, double precision, double precision, double precision,
  boolean, text, text, text, uuid, text, double precision
) TO authenticated, service_role;

-- Patch process_auto_attendance_event in place (idempotent markers).
DO $pa$
DECLARE
  def text;
  present_old text;
  present_new text;
  dup_old text;
  dup_new text;
BEGIN
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );

  -- Keep enrollment after outside_window
  def := regexp_replace(
    def,
    $$'reason',\s*'outside_window',\s*'stop_tracking',\s*true,$$,
    $$'reason', 'outside_window',
      'stop_tracking', false,$$,
    'g'
  );

  -- Add v_shared jsonb once
  IF position('v_shared jsonb' in def) = 0 THEN
    def := replace(
      def,
      'v_tz TEXT;',
      'v_tz TEXT;
  v_shared jsonb;'
    );
  END IF;

  -- Replace inline PRESENT check-in with shared helper (or re-apply if old body still present)
  IF position('scorr_reentry_shared_checkin_v1' in def) = 0 THEN
    present_old := $old$-- PRESENT → check-in / new visit
  --------------------------------------------------------------------------
  IF v_present THEN
    IF v_rec.id IS NOT NULL AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL AND v_has_visit THEN
      v_action := 'already_checked_in';
    ELSIF NOT public.attendance_checkin_allowed(v_dev.user_id, v_corr.occurred_at) THEN
      v_action := 'checkin_blocked_shift_ended';
    ELSIF public.attendance_is_wfh_day(v_dev.user_id, v_att_date) THEN
      v_action := 'wfh_skip';
    ELSIF NOT v_wifi_ok THEN
      v_action := 'not_on_office_network';
    ELSE
      INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
        reviewed_by, reviewed_at, presence_method, wifi_network_id, wifi_network_label
      ) VALUES (
        v_dev.user_id, v_att_date, 'present', 'approved', v_dev.user_id,
        v_corr.occurred_at, p_latitude, p_longitude, v_source, v_win.shift_id,
        'Auto check-in (' || COALESCE(v_method, 'auto') || ') at ' || COALESCE(v_zone.name, 'office')
          || CASE WHEN v_wifi_network_label IS NOT NULL THEN ' [' || v_wifi_network_label || ']' ELSE '' END,
        v_dev.user_id, v_now, v_method, v_wifi_network_id, v_wifi_network_label
      )
      ON CONFLICT (user_id, attendance_date) DO UPDATE SET
        clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
        clock_out_at = NULL,
        clock_out_lat = NULL,
        clock_out_lng = NULL,
        status = 'present',
        approval_status = 'approved',
        attendance_source = CASE
          WHEN public.attendance_records.clock_in_at IS NULL OR public.attendance_records.clock_out_at IS NOT NULL
          THEN EXCLUDED.attendance_source
          ELSE public.attendance_records.attendance_source
        END,
        presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
        wifi_network_id = COALESCE(EXCLUDED.wifi_network_id, public.attendance_records.wifi_network_id),
        wifi_network_label = COALESCE(EXCLUDED.wifi_network_label, public.attendance_records.wifi_network_label),
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id),
        notes = CASE
          WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
          THEN EXCLUDED.notes ELSE public.attendance_records.notes
        END
      RETURNING * INTO v_rec;

      PERFORM public.attendance_ensure_open_visit(
        v_dev.user_id, v_rec.id, v_att_date, v_corr.occurred_at,
        'Auto entry ' || COALESCE(v_method, '')
      );
      UPDATE public.attendance_visit_segments SET
        clock_in_lat = COALESCE(clock_in_lat, p_latitude),
        clock_in_lng = COALESCE(clock_in_lng, p_longitude),
        site_name = COALESCE(site_name, v_zone.name),
        wifi_network_id = COALESCE(v_wifi_network_id, wifi_network_id),
        wifi_network_label = COALESCE(v_wifi_network_label, wifi_network_label)
      WHERE user_id = v_dev.user_id
        AND attendance_date = v_att_date
        AND clock_out_at IS NULL;
      v_action := 'clock_in';
    END IF;$old$;

    present_new := $new$-- PRESENT → check-in / new visit
  --------------------------------------------------------------------------
  IF v_present THEN
    -- scorr_reentry_shared_checkin_v1
    IF v_has_visit THEN
      v_action := 'already_checked_in';
    ELSE
      v_shared := public.attendance_try_auto_checkin(
        v_dev.user_id,
        v_corr.occurred_at,
        p_latitude,
        p_longitude,
        p_accuracy_m,
        COALESCE(p_is_mock, false),
        p_client_ip,
        v_dev.platform,
        v_zone.name,
        v_wifi_network_id,
        v_wifi_network_label,
        v_dist
      );
      v_action := COALESCE(v_shared->>'action', 'none');
      IF v_action = 'clock_in' THEN
        v_notify_msg := COALESCE(v_shared->>'notify_message', v_notify_msg);
        SELECT * INTO v_rec
        FROM public.attendance_records ar
        WHERE ar.user_id = v_dev.user_id
          AND ar.attendance_date = v_att_date;
      END IF;
    END IF;$new$;

    IF position(present_old in def) = 0 THEN
      RAISE EXCEPTION 'reentry: PRESENT block not found for shared check-in patch';
    END IF;
    def := replace(def, present_old, present_new);
  END IF;

  -- Office Wi-Fi with location off must count as present (re-entry / first check-in).
  IF position('scorr_reentry_wifi_present_v1' in def) = 0 THEN
    IF position($w$IF v_event = 'heartbeat' AND v_wifi_ok AND NOT v_present AND NOT COALESCE(v_left, false) THEN$w$ in def) = 0 THEN
      RAISE EXCEPTION 'reentry: wifi-present heartbeat gate not found';
    END IF;
    def := replace(
      def,
      $w$IF v_event = 'heartbeat' AND v_wifi_ok AND NOT v_present AND NOT COALESCE(v_left, false) THEN$w$,
      $w$-- scorr_reentry_wifi_present_v1
  IF v_wifi_ok AND NOT v_present AND NOT COALESCE(v_left, false)
     AND v_event IN ('heartbeat', 'ping', 'enter', 'wifi_connected', 'network_change', 'power_on') THEN$w$
    );
  END IF;

  -- After check-out: never return duplicate_ignored (blocks re-entry / Wi-Fi retry)
  IF position('scorr_reentry_no_dup_after_checkout' in def) = 0 THEN
    dup_old := $d$IF v_dup AND v_event NOT IN ('heartbeat', 'ping', 'exit') AND v_leave_mode IS DISTINCT FROM 'immediate' THEN
    IF EXISTS (
      SELECT 1 FROM public.attendance_records ar
      WHERE ar.user_id = v_dev.user_id
        AND ar.attendance_date = v_att_date
        AND ar.clock_in_at IS NOT NULL
        AND ar.clock_out_at IS NULL
    ) THEN
      RETURN jsonb_build_object(
        'ok', true,
        'action', 'already_checked_in',
        'reason', 'duplicate_within_5m',
        'attendance_date', v_att_date
      );
    END IF;
    RETURN jsonb_build_object('ok', true, 'action', 'duplicate_ignored', 'reason', 'duplicate_within_5m');
  END IF;$d$;
    dup_new := $d$IF v_dup AND v_event NOT IN ('heartbeat', 'ping', 'exit') AND v_leave_mode IS DISTINCT FROM 'immediate' THEN
    -- scorr_reentry_no_dup_after_checkout
    IF EXISTS (
      SELECT 1 FROM public.attendance_visit_segments vs
      WHERE vs.user_id = v_dev.user_id
        AND vs.clock_out_at IS NULL
        AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
    ) OR EXISTS (
      SELECT 1 FROM public.attendance_records ar
      WHERE ar.user_id = v_dev.user_id
        AND ar.attendance_date = v_att_date
        AND ar.clock_in_at IS NOT NULL
        AND ar.clock_out_at IS NULL
    ) THEN
      RETURN jsonb_build_object(
        'ok', true,
        'action', 'already_checked_in',
        'reason', 'duplicate_within_5m',
        'attendance_date', v_att_date
      );
    END IF;
    -- No open visit: continue so re-entry / Wi-Fi retry can run.
  END IF;$d$;
    IF position(dup_old in def) = 0 THEN
      RAISE EXCEPTION 'reentry: duplicate_ignored block not found';
    END IF;
    def := replace(def, dup_old, dup_new);
  END IF;

  EXECUTE def;
END $pa$;

-- process_geo: same shared check-in when no open visit
DO $geo$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef(
    'public.process_geo_attendance_ping(double precision,double precision,double precision)'::regprocedure
  );
  IF def LIKE '%scorr_geo_shared_checkin_v1%' THEN
    RAISE NOTICE 'process_geo already patched';
    RETURN;
  END IF;

  IF position('v_geo_shared jsonb' in def) = 0 THEN
    def := replace(
      def,
      'v_shift_closed INTEGER := 0;',
      'v_shift_closed INTEGER := 0;
    v_geo_shared jsonb;'
    );
  END IF;

  IF position('v_demo := public.is_demo_user(v_user_id);' in def) = 0 THEN
    -- Alternate 4-arg overload may differ; try common anchor
    IF position('v_demo := public.is_demo_user(v_user_id);' in def) = 0 THEN
      RAISE NOTICE 'process_geo demo anchor missing — skip geo shared patch';
      RETURN;
    END IF;
  END IF;

  def := replace(
    def,
    'v_demo := public.is_demo_user(v_user_id);',
    $i$v_demo := public.is_demo_user(v_user_id);
    -- scorr_geo_shared_checkin_v1
    IF NOT EXISTS (
      SELECT 1 FROM public.attendance_visit_segments vs
      WHERE vs.user_id = v_user_id AND vs.clock_out_at IS NULL
    ) THEN
      v_geo_shared := public.attendance_try_auto_checkin(
        v_user_id, v_now,
        p_latitude, p_longitude, p_accuracy,
        false,
        CASE WHEN inet_client_addr() IS NULL THEN NULL ELSE host(inet_client_addr())::text END,
        COALESCE((
          SELECT lower(d.platform) FROM public.attendance_devices d
          WHERE d.user_id = v_user_id AND d.revoked_at IS NULL
          ORDER BY d.last_seen_at DESC NULLS LAST LIMIT 1
        ), 'web'),
        NULL, NULL, NULL, NULL
      );
      IF COALESCE(v_geo_shared->>'action', '') = 'clock_in' THEN
        RETURN jsonb_build_object(
          'action', 'clock_in',
          'reason', 'clock_in',
          'attendance_source', v_geo_shared->>'attendance_source',
          'local_time', v_geo_shared->>'local_time',
          'notify_message', v_geo_shared->>'notify_message',
          'inside', true
        );
      END IF;
    END IF;$i$
  );

  EXECUTE def;
END $geo$;

NOTIFY pgrst, 'reload schema';
