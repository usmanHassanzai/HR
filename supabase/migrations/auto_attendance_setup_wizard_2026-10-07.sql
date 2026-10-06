-- Auto attendance setup eligibility + admin reminder helpers

CREATE OR REPLACE FUNCTION public.get_auto_attendance_setup_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_co public.companies%ROWTYPE;
  v_office_name TEXT;
  v_office_id UUID;
  v_shift_name TEXT;
  v_shift_id UUID;
  v_has_device BOOLEAN := false;
  v_platform_devices INT := 0;
  v_issues TEXT[] := '{}';
  v_ok BOOLEAN := true;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_co FROM public.companies WHERE id = v_me.company_id;

  SELECT o.id, o.name INTO v_office_id, v_office_name
  FROM public.employee_work_sites ews
  JOIN public.office_locations o ON o.id = ews.office_location_id
  WHERE ews.user_id = v_uid
    AND COALESCE(ews.tracking_enabled, true)
    AND COALESCE(o.active, true)
  ORDER BY ews.updated_at DESC NULLS LAST
  LIMIT 1;

  SELECT ws.id, ws.name INTO v_shift_id, v_shift_name
  FROM public.employee_shift_assignments esa
  JOIN public.work_shifts ws ON ws.id = esa.shift_id
  WHERE esa.user_id = v_uid
    AND COALESCE(ws.active, true)
    AND (esa.effective_to IS NULL OR esa.effective_to >= CURRENT_DATE)
  ORDER BY esa.effective_from DESC NULLS LAST
  LIMIT 1;

  IF v_shift_id IS NULL THEN
    SELECT ws.id, ws.name INTO v_shift_id, v_shift_name
    FROM public.work_shifts ws
    JOIN public.users m ON m.id = ws.manager_id
    WHERE m.company_id = v_me.company_id
      AND COALESCE(ws.apply_to_all, false)
      AND COALESCE(ws.active, true)
    ORDER BY ws.updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  -- remove broken company_id branch — work_shifts has manager_id only


  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = v_uid AND d.revoked_at IS NULL
  ) INTO v_has_device;

  SELECT count(*)::int INTO v_platform_devices
  FROM public.attendance_devices d
  WHERE d.user_id = v_uid AND d.revoked_at IS NULL;

  IF NOT COALESCE(v_co.auto_phone_attendance, false) AND NOT COALESCE(v_co.auto_laptop_attendance, false) THEN
    v_issues := array_append(v_issues, 'Company automatic attendance is OFF. An admin must enable phone and/or laptop attendance.');
    v_ok := false;
  END IF;

  IF COALESCE(v_me.work_mode, 'office') = 'remote' THEN
    v_issues := array_append(v_issues, 'Your work location is Remote. Automatic office check-in is only for Office or Hybrid staff.');
    v_ok := false;
  END IF;

  IF v_office_id IS NULL THEN
    v_issues := array_append(v_issues, 'You are not assigned to an office zone. Ask your admin (Office & Attendance → Assign people).');
    v_ok := false;
  END IF;

  IF v_shift_id IS NULL THEN
    v_issues := array_append(v_issues, 'You are not assigned to a shift. Ask your admin to assign a work shift.');
    v_ok := false;
  END IF;

  RETURN jsonb_build_object(
    'ok', v_ok,
    'issues', to_jsonb(v_issues),
    'user', jsonb_build_object(
      'id', v_me.id,
      'full_name', v_me.full_name,
      'email', v_me.email,
      'role', v_me.role,
      'work_mode', COALESCE(v_me.work_mode, 'office'),
      'auto_phone_attendance', COALESCE(v_me.auto_phone_attendance, false),
      'auto_laptop_attendance', COALESCE(v_me.auto_laptop_attendance, false)
    ),
    'company', jsonb_build_object(
      'id', v_co.id,
      'name', v_co.name,
      'timezone', v_co.timezone,
      'auto_phone_attendance', COALESCE(v_co.auto_phone_attendance, false),
      'auto_laptop_attendance', COALESCE(v_co.auto_laptop_attendance, false)
    ),
    'office', CASE WHEN v_office_id IS NULL THEN NULL ELSE jsonb_build_object('id', v_office_id, 'name', v_office_name) END,
    'shift', CASE WHEN v_shift_id IS NULL THEN NULL ELSE jsonb_build_object('id', v_shift_id, 'name', v_shift_name) END,
    'has_enrolled_device', v_has_device,
    'enrolled_device_count', v_platform_devices,
    'is_admin', v_me.role IN ('admin', 'hr')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_company_attendance_devices_detailed()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  full_name TEXT,
  email TEXT,
  role TEXT,
  platform TEXT,
  device_id TEXT,
  app_version TEXT,
  device_timezone TEXT,
  last_seen_at TIMESTAMPTZ,
  last_clock_skew_ms BIGINT,
  revoked_at TIMESTAMPTZ,
  presence_state TEXT,
  last_matched_method TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY
  SELECT
    d.id, d.user_id, u.full_name, u.email, u.role::text,
    d.platform, d.device_id, d.app_version, d.device_timezone,
    d.last_seen_at, d.last_clock_skew_ms, d.revoked_at, d.presence_state,
    d.last_matched_method, d.created_at
  FROM public.attendance_devices d
  JOIN public.users u ON u.id = d.user_id
  WHERE d.company_id = v_me.company_id
  ORDER BY d.revoked_at NULLS FIRST, d.last_seen_at DESC NULLS LAST;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_auto_attendance_setup_reminder(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF v_me.role NOT IN ('admin', 'hr') OR v_me.company_id IS DISTINCT FROM v_target.company_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, meta)
  VALUES (
    p_user_id,
    'Set up automatic attendance',
    'Install the Scorr app, sign in, then open Settings → Automatic attendance and follow the setup steps. Download: https://scorr.walfia.ai/#download-app',
    'reminder',
    jsonb_build_object('kind', 'attendance_setup', 'link', 'https://scorr.walfia.ai/#download-app')
  );

  RETURN jsonb_build_object('ok', true, 'user_id', p_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_auto_attendance_setup_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_company_attendance_devices_detailed() TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_auto_attendance_setup_reminder(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
