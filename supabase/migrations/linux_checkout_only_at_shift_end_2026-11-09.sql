-- Linux auto attendance: check in from 1 hour before the shift until it ends.
-- Do not check out when office Wi-Fi or the office radius is lost during the shift.
-- When the shift ends, close the open session at the shift end time.
-- Manual Clock Out is unchanged. Windows, Android, and the website keep their rules.

CREATE OR REPLACE FUNCTION public.attendance_device_early_checkout(
  p_user_id uuid,
  p_device_row_id uuid,
  p_company_id uuid,
  p_platform text,
  p_event text,
  p_occurred timestamptz,
  p_now timestamptz,
  p_zone_id uuid DEFAULT NULL,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL,
  p_ssid text DEFAULT NULL,
  p_bssid text DEFAULT NULL,
  p_client_ip text DEFAULT NULL,
  p_platform_variant text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
  v_rec public.attendance_records%ROWTYPE;
  v_att_date DATE;
  v_out TIMESTAMPTZ;
  v_total INTEGER;
  v_tz TEXT;
BEGIN
  -- Linux and Windows 11 do not auto check out when Wi-Fi or GPS drops.
  -- Manual Clock Out still uses the attendance screen. Shift end closes the session.
  IF lower(btrim(COALESCE(p_platform, ''))) = 'linux'
     OR lower(btrim(COALESCE(p_platform_variant, ''))) = 'windows11' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'ignored',
      'reason', 'desktop_checkout_only_at_shift_end',
      'session_open', true,
      'suppress_checkin', true,
      'message', 'Stays checked in until shift end or a manual Clock Out.'
    );
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_gone', 'action', 'user_gone');
  END IF;

  SELECT * INTO v_win
  FROM public.attendance_window_for_user(p_user_id, p_occurred)
  LIMIT 1;

  IF NOT COALESCE(v_win.has_shift, false)
     OR v_win.shift_start_utc IS NULL
     OR v_win.shift_end_utc IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'no_shift',
      'action', 'no_shift',
      'message', 'No shift assigned for this time.'
    );
  END IF;

  v_att_date := v_win.attendance_date;

  IF p_occurred < v_win.shift_start_utc THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'checkout_before_shift_start',
      'action', 'checkout_before_shift_start',
      'shift_start_utc', v_win.shift_start_utc,
      'shift_end_utc', v_win.shift_end_utc,
      'server_now_utc', p_now,
      'message', 'Check-out is only allowed after shift start and before shift end.'
    );
  END IF;

  IF p_occurred >= v_win.shift_end_utc THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'checkout_after_shift_end',
      'action', 'checkout_after_shift_end',
      'stop_tracking', true,
      'shift_start_utc', v_win.shift_start_utc,
      'shift_end_utc', v_win.shift_end_utc,
      'server_now_utc', p_now,
      'message', 'Shift has ended. Open sessions are closed at shift end automatically.'
    );
  END IF;

  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = p_user_id AND attendance_date = v_att_date;

  IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'ignored',
      'reason', 'not_checked_in',
      'ignored', true,
      'session_open', false,
      'suppress_checkin', false,
      'resume_checkin', true,
      'message', 'No open check-in to close.'
    );
  END IF;

  -- Already closed → allow client to try re-entry check-in (do not stop tracking)
  IF v_rec.clock_out_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'ignored',
      'reason', 'already_checked_out',
      'ignored', true,
      'session_open', false,
      'suppress_checkin', false,
      'resume_checkin', true,
      'stop_tracking', false,
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'message', 'Already checked out; re-entry check-in is allowed if back on office Wi-Fi or radius.'
    );
  END IF;

  v_out := GREATEST(v_rec.clock_in_at, p_occurred);
  IF v_out >= v_win.shift_end_utc THEN
    v_out := v_win.shift_end_utc - INTERVAL '1 second';
    IF v_out < v_rec.clock_in_at THEN
      v_out := v_rec.clock_in_at;
    END IF;
  END IF;

  UPDATE public.attendance_visit_segments SET
    clock_out_at = GREATEST(clock_in_at, v_out),
    clock_out_lat = COALESCE(p_latitude, clock_out_lat),
    clock_out_lng = COALESCE(p_longitude, clock_out_lng),
    work_minutes = GREATEST(
      0,
      (EXTRACT(EPOCH FROM (GREATEST(clock_in_at, v_out) - clock_in_at)) / 60)::INTEGER
    ),
    notes = CASE
      WHEN COALESCE(notes, '') ILIKE '%early check-out%' THEN notes
      ELSE trim(both ' |' from COALESCE(notes, '') || ' | Early check-out (any location)')
    END
  WHERE user_id = p_user_id
    AND attendance_date = v_att_date
    AND clock_out_at IS NULL;

  IF NOT EXISTS (
    SELECT 1
    FROM public.attendance_visit_segments
    WHERE user_id = p_user_id AND attendance_date = v_att_date
  ) THEN
    INSERT INTO public.attendance_visit_segments (
      user_id, attendance_record_id, attendance_date, visit_number,
      clock_in_at, clock_out_at, clock_out_lat, clock_out_lng, work_minutes, notes
    ) VALUES (
      p_user_id, v_rec.id, v_att_date, 1,
      v_rec.clock_in_at, v_out, p_latitude, p_longitude,
      GREATEST(0, (EXTRACT(EPOCH FROM (v_out - v_rec.clock_in_at)) / 60)::INTEGER),
      'Early check-out (any location)'
    );
  END IF;

  v_total := public.attendance_day_total_minutes(p_user_id, v_att_date, v_out);

  UPDATE public.attendance_records SET
    clock_out_at = v_out,
    clock_out_lat = COALESCE(p_latitude, clock_out_lat),
    clock_out_lng = COALESCE(p_longitude, clock_out_lng),
    work_minutes = v_total,
    notes = CASE
      WHEN COALESCE(notes, '') ILIKE '%early check-out%' THEN notes
      ELSE trim(both ' |' from COALESCE(notes, '') || ' | Early check-out (any location)')
    END
  WHERE id = v_rec.id;

  BEGIN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      zone_id, latitude, longitude, accuracy_m, ssid, bssid, occurred_at, payload
    ) VALUES (
      p_company_id, p_user_id, p_device_row_id, p_event, true, 'clock_out', p_client_ip,
      p_zone_id, p_latitude, p_longitude, p_accuracy_m,
      NULLIF(btrim(COALESCE(p_ssid, '')), ''),
      NULLIF(lower(btrim(COALESCE(p_bssid, ''))), ''),
      p_occurred,
      jsonb_build_object(
        'platform', p_platform,
        'rule', 'early_checkout_any_location',
        'window', 'shift_start_to_end',
        'location_required', false,
        'reentry_allowed', true
      )
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  v_tz := COALESCE(
    NULLIF(btrim((SELECT timezone FROM public.work_shifts WHERE id = v_rec.shift_id)), ''),
    public.company_timezone((SELECT company_id FROM public.users WHERE id = p_user_id)),
    public.app_timezone(),
    'UTC'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'clock_out',
    'reason', 'early_checkout_any_location',
    'attendance_record_id', v_rec.id,
    'attendance_date', v_att_date,
    'clock_out_at', v_out,
    'local_time', to_char(timezone(v_tz, v_out), 'HH24:MI'),
    'shift_start_utc', v_win.shift_start_utc,
    'shift_end_utc', v_win.shift_end_utc,
    'session_open', false,
    'suppress_checkin', false,
    'resume_checkin', true,
    'stop_tracking', false,
    'location_required', false,
    'message', 'Checked out during the shift. Returning to office Wi-Fi or radius will check you in again.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_device_early_checkout(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  uuid, double precision, double precision, double precision,
  text, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.close_open_attendance_if_shift_ended(
    p_user_id UUID,
    p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r public.attendance_records%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_end TIMESTAMPTZ;
    v_grace_end TIMESTAMPTZ;
    v_out TIMESTAMPTZ;
    v_shift_id UUID;
    v_start TIME;
    v_end_t TIME;
    v_seen TIMESTAMPTZ;
    v_online BOOLEAN;
    v_linux BOOLEAN := false;
    n INTEGER := 0;
    v_total INTEGER;
    v_last_out TIMESTAMPTZ;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT u.last_seen_at INTO v_seen FROM public.users u WHERE u.id = p_user_id;
    v_online := v_seen IS NOT NULL AND v_seen > v_now - INTERVAL '8 minutes';
    SELECT EXISTS (
        SELECT 1
        FROM public.attendance_devices d
        WHERE d.user_id = p_user_id
          AND d.platform = 'linux'
          AND d.revoked_at IS NULL
    ) INTO v_linux;

    -- 1) Close open day records whose shift has ended.
    FOR r IN
        SELECT *
        FROM public.attendance_records ar
        WHERE ar.user_id = p_user_id
          AND ar.clock_in_at IS NOT NULL
          AND ar.clock_out_at IS NULL
          AND ar.status IS DISTINCT FROM 'absent'
    LOOP
        SELECT s.shift_id, s.start_time, s.end_time
        INTO v_shift_id, v_start, v_end_t
        FROM public.get_active_shift_for_user(p_user_id, r.attendance_date) s
        LIMIT 1;

        IF v_shift_id IS NULL THEN
            CONTINUE;
        END IF;

        v_end := public.shift_end_timestamptz(r.attendance_date, v_start, v_end_t, r.clock_in_at);
        v_grace_end := v_end + (public.shift_edge_minutes() || ' minutes')::INTERVAL;

        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        -- Linux checks out at the shift end even if Scorr is still open.
        -- Other platforms wait through the post-shift grace window while online.
        IF v_online AND v_now < v_grace_end AND NOT v_linux THEN
            CONTINUE;
        END IF;

        IF v_linux OR v_seen IS NULL OR v_seen < v_end THEN
            v_out := v_end;
        ELSIF v_now >= v_grace_end THEN
            v_out := v_grace_end;
        ELSE
            v_out := LEAST(v_grace_end, GREATEST(v_end, v_seen));
        END IF;
        v_out := GREATEST(r.clock_in_at, v_out);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_out - clock_in_at)) / 60)::INTEGER),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Closed (shift ended)')
            END
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        IF NOT EXISTS (
            SELECT 1
            FROM public.attendance_visit_segments
            WHERE user_id = p_user_id AND attendance_date = r.attendance_date
        ) THEN
            INSERT INTO public.attendance_visit_segments (
                user_id, attendance_record_id, attendance_date, visit_number,
                clock_in_at, clock_out_at, work_minutes, notes
            ) VALUES (
                p_user_id, r.id, r.attendance_date, 1,
                r.clock_in_at, v_out,
                GREATEST(0, (EXTRACT(EPOCH FROM (v_out - r.clock_in_at)) / 60)::INTEGER),
                'Auto clock-out (shift ended)'
            );
        END IF;

        v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);

        UPDATE public.attendance_records SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = v_total,
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Auto clock-out (shift ended)')
            END
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    -- 2) Orphan open visits after shift end (record may already show clock_out).
    FOR r IN
        SELECT DISTINCT ON (ar.id) ar.*
        FROM public.attendance_records ar
        JOIN public.attendance_visit_segments vs
          ON vs.user_id = ar.user_id
         AND vs.attendance_date = ar.attendance_date
         AND vs.clock_out_at IS NULL
        WHERE ar.user_id = p_user_id
          AND ar.status IS DISTINCT FROM 'absent'
        ORDER BY ar.id
    LOOP
        SELECT s.shift_id, s.start_time, s.end_time
        INTO v_shift_id, v_start, v_end_t
        FROM public.get_active_shift_for_user(p_user_id, r.attendance_date) s
        LIMIT 1;

        IF v_shift_id IS NULL THEN
            CONTINUE;
        END IF;

        v_end := public.shift_end_timestamptz(
            r.attendance_date, v_start, v_end_t, COALESCE(r.clock_in_at, r.created_at)
        );
        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        v_out := COALESCE(r.clock_out_at, v_end);
        IF v_out < v_end THEN
            v_out := v_end;
        END IF;

        UPDATE public.attendance_visit_segments SET
            clock_out_at = GREATEST(clock_in_at, v_out),
            work_minutes = GREATEST(
                0,
                (EXTRACT(EPOCH FROM (GREATEST(clock_in_at, v_out) - clock_in_at)) / 60)::INTEGER
            ),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Closed (shift ended)')
            END
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);

        SELECT MAX(vs.clock_out_at)
        INTO v_last_out
        FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id AND vs.attendance_date = r.attendance_date;

        UPDATE public.attendance_records SET
            clock_out_at = COALESCE(clock_out_at, v_last_out, v_out),
            work_minutes = v_total
        WHERE id = r.id
          AND (
              clock_out_at IS NULL
              OR work_minutes IS DISTINCT FROM v_total
          );

        n := n + 1;
    END LOOP;

    -- 3) Visits all closed but day record still open → sync clock_out from visits.
    FOR r IN
        SELECT ar.*
        FROM public.attendance_records ar
        WHERE ar.user_id = p_user_id
          AND ar.clock_in_at IS NOT NULL
          AND ar.clock_out_at IS NULL
          AND ar.status IS DISTINCT FROM 'absent'
          AND EXISTS (
              SELECT 1 FROM public.attendance_visit_segments vs
              WHERE vs.user_id = ar.user_id AND vs.attendance_date = ar.attendance_date
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.attendance_visit_segments vs
              WHERE vs.user_id = ar.user_id
                AND vs.attendance_date = ar.attendance_date
                AND vs.clock_out_at IS NULL
          )
    LOOP
        SELECT MAX(vs.clock_out_at), public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_now)
        INTO v_last_out, v_total
        FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id AND vs.attendance_date = r.attendance_date;

        IF v_last_out IS NULL THEN
            CONTINUE;
        END IF;

        UPDATE public.attendance_records SET
            clock_out_at = v_last_out,
            work_minutes = v_total,
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Synced clock-out from visits')
            END
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

NOTIFY pgrst, 'reload schema';
