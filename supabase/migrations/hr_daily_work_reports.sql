-- HR submits daily work reports to company admin (same flow as employee/manager).

CREATE OR REPLACE FUNCTION public.submit_daily_work_report(
  p_content TEXT,
  p_report_date DATE DEFAULT NULL
)
RETURNS public.daily_work_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role public.user_role;
  v_date DATE := COALESCE(p_report_date, (timezone('utc', now()))::date);
  v_trimmed TEXT := trim(COALESCE(p_content, ''));
  v_row public.daily_work_reports;
  v_existed BOOLEAN := false;
  v_company_id UUID;
  v_name TEXT;
  v_role_label TEXT;
  v_title TEXT;
  v_message TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, company_id, full_name
  INTO v_role, v_company_id, v_name
  FROM public.users
  WHERE id = v_uid;

  IF v_role IS NULL OR v_role NOT IN (
    'employee'::public.user_role,
    'manager'::public.user_role,
    'hr'::public.user_role
  ) THEN
    RAISE EXCEPTION 'Only employees, managers, and HR can submit daily work reports';
  END IF;

  IF char_length(v_trimmed) < 20 THEN
    RAISE EXCEPTION 'Please write at least 20 characters describing your work today';
  END IF;

  IF char_length(v_trimmed) > 8000 THEN
    RAISE EXCEPTION 'Report is too long (max 8000 characters)';
  END IF;

  IF v_date > (timezone('utc', now()))::date THEN
    RAISE EXCEPTION 'Cannot submit a report for a future date';
  END IF;

  IF v_date < (timezone('utc', now()))::date - 7 THEN
    RAISE EXCEPTION 'Reports can only be submitted or updated for the last 7 days';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.daily_work_reports r
    WHERE r.user_id = v_uid
      AND r.report_date = v_date
  ) INTO v_existed;

  INSERT INTO public.daily_work_reports (user_id, report_date, content, submitted_at, updated_at)
  VALUES (v_uid, v_date, v_trimmed, timezone('utc', now()), timezone('utc', now()))
  ON CONFLICT (user_id, report_date) DO UPDATE
    SET content = EXCLUDED.content,
        updated_at = timezone('utc', now())
  RETURNING * INTO v_row;

  v_role_label := CASE
    WHEN v_role = 'manager'::public.user_role THEN 'Manager'
    WHEN v_role = 'hr'::public.user_role THEN 'HR'
    ELSE 'Employee'
  END;

  IF v_existed THEN
    v_title := 'Daily report updated';
    v_message := COALESCE(v_name, 'A team member') || ' (' || v_role_label || ') updated their daily report for '
      || to_char(v_date, 'Mon DD, YYYY')
      || '. Open Daily Reports to review.';
  ELSE
    v_title := 'New daily report';
    v_message := COALESCE(v_name, 'A team member') || ' (' || v_role_label || ') submitted a daily report for '
      || to_char(v_date, 'Mon DD, YYYY')
      || '. Open Daily Reports to review.';
  END IF;

  -- HR (and staff) report to company admin only — not to other HR.
  INSERT INTO public.notifications (user_id, title, message, type, meta)
  SELECT a.id, v_title, v_message, 'info'::public.notification_type,
    jsonb_build_object('kind', 'daily_report', 'reportId', v_row.id, 'userId', v_uid, 'search', COALESCE(v_name, ''))
  FROM public.users a
  WHERE a.role = 'admin'::public.user_role
    AND a.company_id IS NOT DISTINCT FROM v_company_id
    AND a.id <> v_uid;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_daily_work_report(TEXT, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_daily_work_reports(
  p_department_id UUID DEFAULT NULL,
  p_report_date DATE DEFAULT NULL,
  p_role TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  full_name TEXT,
  email TEXT,
  role TEXT,
  department_id UUID,
  department_name TEXT,
  report_date DATE,
  content TEXT,
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company UUID;
  v_search TEXT := NULLIF(trim(COALESCE(p_search, '')), '');
  v_is_demo BOOLEAN := public.is_demo_user(auth.uid());
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  v_company := public.current_company_id();
  IF NOT v_is_demo AND v_company IS NULL THEN
    RAISE EXCEPTION 'Your account is not linked to a company';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    u.id AS user_id,
    u.full_name::TEXT,
    u.email::TEXT,
    u.role::TEXT,
    u.department_id,
    COALESCE(d.name, 'Unassigned')::TEXT AS department_name,
    r.report_date,
    r.content,
    r.submitted_at,
    r.updated_at
  FROM public.daily_work_reports r
  JOIN public.users u ON u.id = r.user_id
  LEFT JOIN public.departments d ON d.id = u.department_id
  WHERE u.role IN (
      'employee'::public.user_role,
      'manager'::public.user_role,
      'hr'::public.user_role
    )
    AND COALESCE(u.is_platform_owner, false) = false
    AND (
      (v_is_demo AND COALESCE(u.is_demo, false) = true)
      OR (NOT v_is_demo AND u.company_id = v_company AND COALESCE(u.is_demo, false) = false)
    )
    AND (p_department_id IS NULL OR u.department_id = p_department_id)
    AND (p_report_date IS NULL OR r.report_date = p_report_date)
    AND (p_role IS NULL OR p_role = '' OR u.role::TEXT = p_role)
    AND (
      v_search IS NULL
      OR u.full_name ILIKE '%' || v_search || '%'
      OR u.email ILIKE '%' || v_search || '%'
      OR r.content ILIKE '%' || v_search || '%'
    )
  ORDER BY r.report_date DESC, d.name NULLS LAST, u.role DESC, u.full_name ASC
  LIMIT 500;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_daily_work_reports(UUID, DATE, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_daily_report_dept_summary(
  p_report_date DATE DEFAULT NULL
)
RETURNS TABLE (
  department_id UUID,
  department_name TEXT,
  total_staff BIGINT,
  submitted_count BIGINT,
  manager_count BIGINT,
  employee_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company UUID;
  v_date DATE := COALESCE(p_report_date, (timezone('utc', now()))::date);
  v_is_demo BOOLEAN := public.is_demo_user(auth.uid());
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  v_company := public.current_company_id();
  IF NOT v_is_demo AND v_company IS NULL THEN
    RAISE EXCEPTION 'Your account is not linked to a company';
  END IF;

  RETURN QUERY
  WITH staff AS (
    SELECT
      u.id,
      u.role,
      u.department_id,
      COALESCE(d.name, 'Unassigned') AS dept_name
    FROM public.users u
    LEFT JOIN public.departments d ON d.id = u.department_id
    WHERE u.role IN (
        'employee'::public.user_role,
        'manager'::public.user_role,
        'hr'::public.user_role
      )
      AND COALESCE(u.is_platform_owner, false) = false
      AND (
        (v_is_demo AND COALESCE(u.is_demo, false) = true)
        OR (NOT v_is_demo AND u.company_id = v_company AND COALESCE(u.is_demo, false) = false)
      )
  ),
  submitted AS (
    SELECT r.user_id
    FROM public.daily_work_reports r
    WHERE r.report_date = v_date
  )
  SELECT
    s.department_id,
    s.dept_name::TEXT AS department_name,
    COUNT(*)::BIGINT AS total_staff,
    COUNT(sub.user_id)::BIGINT AS submitted_count,
    COUNT(*) FILTER (WHERE s.role = 'manager'::public.user_role)::BIGINT AS manager_count,
    COUNT(*) FILTER (
      WHERE s.role IN ('employee'::public.user_role, 'hr'::public.user_role)
    )::BIGINT AS employee_count
  FROM staff s
  LEFT JOIN submitted sub ON sub.user_id = s.id
  GROUP BY s.department_id, s.dept_name
  ORDER BY s.dept_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_daily_report_dept_summary(DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
