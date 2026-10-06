-- attendance_auto_tests.sql
-- R60–R64, R75 core automated SQL tests. Raises on failure.

DO $$
DECLARE
  v_company_a UUID;
  v_company_b UUID;
  v_dept UUID;
  v_admin_a UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_shift UUID;
  v_zone UUID;
  v_win RECORD;
  v_corr RECORD;
  v_hash TEXT;
  v_token TEXT := 'test-token-' || gen_random_uuid()::TEXT;
  v_dev UUID;
  v_res JSONB;
  v_fail TEXT := '';
  v_at TIMESTAMPTZ := '2026-10-06 14:00:00+00'::TIMESTAMPTZ;
  v_sfx TEXT := substr(gen_random_uuid()::TEXT, 1, 8);
  v_now_ms BIGINT;
  v_in_ms BIGINT;
  v_win_now RECORD;
BEGIN
  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('SCORR_TEST_A_' || v_sfx, 'scorr-test-a-' || v_sfx, 'a_' || v_sfx || '@scorr.test', 'Asia/Karachi', true, true)
  RETURNING id INTO v_company_a;

  INSERT INTO public.companies (name, slug, contact_email, timezone)
  VALUES ('SCORR_TEST_B_' || v_sfx, 'scorr-test-b-' || v_sfx, 'b_' || v_sfx || '@scorr.test', 'Asia/Karachi')
  RETURNING id INTO v_company_b;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('Test Dept ' || v_sfx, 'test-dept-' || v_sfx, v_company_a, true)
  RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  (
    '00000000-0000-0000-0000-000000000000', v_admin_a, 'authenticated', 'authenticated',
    'admin_a_' || v_sfx || '@scorr.test',
    '$2a$10$scorrtestscorrtestscorrtestscorroooooooooooooooooooooooo',
    timezone('utc', now()),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role', 'admin', 'company_id', v_company_a, 'full_name', 'Admin A'),
    timezone('utc', now()), timezone('utc', now()), '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_' || v_sfx || '@scorr.test',
    '$2a$10$scorrtestscorrtestscorrtestscorroooooooooooooooooooooooo',
    timezone('utc', now()),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object(
      'role', 'employee',
      'company_id', v_company_a,
      'department_id', v_dept,
      'full_name', 'Emp A'
    ),
    timezone('utc', now()), timezone('utc', now()), '', '', '', ''
  );

  UPDATE public.users SET
    auto_phone_attendance = true,
    auto_laptop_attendance = true,
    work_mode = 'office'
  WHERE id IN (v_emp, v_admin_a);

  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight, is_demo)
  VALUES ('CT Test 8-5', '08:00', '17:00', ARRAY[1,2,3,4,5], 0, true, v_admin_a, 'America/Chicago', false, false)
  RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by, is_demo)
  VALUES (v_emp, v_shift, '2026-01-01', v_admin_a, false);

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 12:00:00+00'::TIMESTAMPTZ);
  IF NOT COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R60 -60m edge; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 11:59:00+00'::TIMESTAMPTZ);
  IF COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R60 61m early; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 23:00:00+00'::TIMESTAMPTZ);
  IF NOT COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R60 +60m edge; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 23:01:00+00'::TIMESTAMPTZ);
  IF COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R60 after +60; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-10 15:00:00+00'::TIMESTAMPTZ);
  IF COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R60 Saturday; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 12:10:00+00'::TIMESTAMPTZ);
  IF NOT COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R61 Oct 5:10 PKT; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 11:55:00+00'::TIMESTAMPTZ);
  IF COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R61 Oct 4:55 PKT; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-11-02 12:30:00+00'::TIMESTAMPTZ);
  IF COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R61 Nov 5:30 PKT; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-11-02 13:10:00+00'::TIMESTAMPTZ);
  IF NOT COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R61 Nov 6:10 PKT; '; END IF;

  SELECT * INTO v_corr FROM public.attendance_correct_occurred_at(
    (EXTRACT(EPOCH FROM v_at) * 1000)::BIGINT,
    (EXTRACT(EPOCH FROM v_at) * 1000 + 30*60*1000)::BIGINT,
    v_at
  );
  IF NOT COALESCE(v_corr.clock_flagged, false) THEN v_fail := v_fail || 'R61 skew flag; '; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2027-03-15 12:10:00+00'::TIMESTAMPTZ);
  IF NOT COALESCE(v_win.in_window, false) THEN v_fail := v_fail || 'R61 Mar2027 DST; '; END IF;

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id, is_demo,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'Test Office ' || v_sfx, 41.8781, -87.6298, 150, true, v_company_a, false,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled, is_demo
  ) VALUES (v_emp, v_zone, 'Test Office', 41.8781, -87.6298, 150, true, false);

  v_hash := public.attendance_hash_device_token(v_token);
  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version)
  VALUES (v_emp, v_company_a, 'test-device-' || v_sfx, 'android', v_hash, '1.4.0')
  RETURNING id INTO v_dev;

  -- Early (61m): device clock correct at sync (device_now ≈ server now), occurred_at early
  v_res := public.process_auto_attendance_event(
    v_hash, 'wifi_connected', v_zone, NULL, NULL, NULL,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM '2026-10-06 11:50:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    (EXTRACT(EPOCH FROM timezone('utc', now()))*1000)::BIGINT,
    'Asia/Karachi', false, 'test-device-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  IF (v_res->>'reason') NOT IN ('outside_window', 'event_too_old') THEN
    v_fail := v_fail || 'R75 early wifi: ' || COALESCE(v_res::TEXT, 'null') || '; ';
  END IF;

  v_now_ms := (EXTRACT(EPOCH FROM timezone('utc', now())) * 1000)::BIGINT;
  SELECT * INTO v_win_now FROM public.attendance_window_for_user(v_emp, timezone('utc', now())) LIMIT 1;
  IF COALESCE(v_win_now.in_window, false) THEN
    v_in_ms := v_now_ms;
  ELSE
    v_in_ms := NULL;
  END IF;

  IF v_in_ms IS NOT NULL THEN
    v_res := public.process_auto_attendance_event(
      v_hash, 'wifi_connected', v_zone, NULL, NULL, NULL,
      'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
      v_in_ms, v_in_ms,
      'Asia/Karachi', false, 'test-device-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
    );
    IF NOT COALESCE((v_res->>'ok')::BOOLEAN, false) OR (v_res->>'action') IS DISTINCT FROM 'clock_in' THEN
      v_fail := v_fail || 'R75 wifi in: ' || COALESCE(v_res::TEXT, 'null') || '; ';
    END IF;

    v_res := public.process_auto_attendance_event(
      v_hash, 'wifi_connected', v_zone, NULL, NULL, NULL,
      'OfficeWiFi', '11:22:33:44:55:66',
      v_in_ms, v_in_ms,
      'Asia/Karachi', false, 'test-device-' || v_sfx, 'android', '1.4.0', '198.51.100.9'
    );
    IF COALESCE((v_res->>'ok')::BOOLEAN, true) OR (v_res->>'reason') IS DISTINCT FROM 'wrong_network' THEN
      v_fail := v_fail || 'R75 fake hotspot; ';
    END IF;
  ELSE
    IF NOT public.attendance_ip_in_cidrs('203.0.113.10', ARRAY['203.0.113.10']) THEN
      v_fail := v_fail || 'R75 IP match helper; ';
    END IF;
    IF public.attendance_ip_in_cidrs('198.51.100.9', ARRAY['203.0.113.10']) THEN
      v_fail := v_fail || 'R75 wrong IP should not match; ';
    END IF;
  END IF;

  UPDATE public.attendance_devices SET revoked_at = timezone('utc', now()) WHERE id = v_dev;
  v_res := public.process_auto_attendance_event(
    v_hash, 'ping', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_now_ms, v_now_ms,
    'Asia/Karachi', false, 'test-device-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  IF (v_res->>'reason') IS DISTINCT FROM 'revoked_token' THEN v_fail := v_fail || 'R62 revoked; '; END IF;
  UPDATE public.attendance_devices SET revoked_at = NULL WHERE id = v_dev;

  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_now_ms, v_now_ms,
    'Asia/Karachi', true, 'test-device-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  IF (v_res->>'reason') IS DISTINCT FROM 'mock_location' THEN v_fail := v_fail || 'R62 mock; '; END IF;

  UPDATE public.companies SET auto_phone_attendance = false WHERE id = v_company_a;
  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_now_ms, v_now_ms,
    'Asia/Karachi', false, 'test-device-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  IF (v_res->>'reason') IS DISTINCT FROM 'feature_off' THEN v_fail := v_fail || 'R62 feature_off; '; END IF;
  UPDATE public.companies SET auto_phone_attendance = true WHERE id = v_company_a;

  BEGIN
    PERFORM public.assert_public_ip_cidrs(ARRAY['192.168.1.1']);
    v_fail := v_fail || 'R75 private IP; ';
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  UPDATE public.attendance_visit_segments SET clock_out_at = timezone('utc', now()) WHERE user_id = v_emp AND clock_out_at IS NULL;
  UPDATE public.attendance_records SET clock_out_at = timezone('utc', now()) WHERE user_id = v_emp AND clock_out_at IS NULL;
  UPDATE public.attendance_devices SET platform = 'windows' WHERE id = v_dev;
  IF v_in_ms IS NOT NULL THEN
    v_res := public.process_auto_attendance_event(
      v_hash, 'power_on', v_zone, NULL, NULL, NULL,
      'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
      v_in_ms, v_in_ms,
      'America/Chicago', false, 'test-device-' || v_sfx, 'windows', '1.4.0', '203.0.113.10'
    );
    IF NOT COALESCE((v_res->>'ok')::BOOLEAN, false) THEN
      v_fail := v_fail || 'R75 laptop: ' || COALESCE(v_res::TEXT, 'null') || '; ';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.attendance_devices WHERE company_id = v_company_b) THEN
    v_fail := v_fail || 'R64 unexpected B devices; ';
  END IF;

  DELETE FROM public.attendance_events_log WHERE company_id = v_company_a;
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;
  DELETE FROM public.attendance_devices WHERE id = v_dev;
  DELETE FROM public.employee_work_sites WHERE user_id = v_emp;
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.office_locations WHERE id = v_zone;
  DELETE FROM public.work_shifts WHERE id = v_shift;
  DELETE FROM auth.users WHERE id IN (v_emp, v_admin_a);
  DELETE FROM public.departments WHERE id = v_dept;
  DELETE FROM public.companies WHERE id IN (v_company_a, v_company_b);

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'attendance_auto_tests FAILED: %', v_fail;
  END IF;

  RAISE NOTICE 'attendance_auto_tests PASSED';
END;
$$;
