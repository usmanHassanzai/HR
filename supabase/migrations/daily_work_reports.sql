-- Daily Work Reports: employees & managers submit daily written work logs;
-- admins review department-wise. Multi-tenant via users.company_id.

CREATE TABLE IF NOT EXISTS public.daily_work_reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    report_date   DATE NOT NULL DEFAULT (timezone('utc'::text, now()))::date,
    content       TEXT NOT NULL,
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT daily_work_reports_content_len CHECK (char_length(trim(content)) >= 20),
    CONSTRAINT daily_work_reports_user_date UNIQUE (user_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_work_reports_user_date
  ON public.daily_work_reports (user_id, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_work_reports_date
  ON public.daily_work_reports (report_date DESC);

ALTER TABLE public.daily_work_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_work_reports_select" ON public.daily_work_reports;
CREATE POLICY "daily_work_reports_select" ON public.daily_work_reports
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin(auth.uid())
  );

DROP POLICY IF EXISTS "daily_work_reports_insert" ON public.daily_work_reports;
CREATE POLICY "daily_work_reports_insert" ON public.daily_work_reports
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "daily_work_reports_update" ON public.daily_work_reports;
CREATE POLICY "daily_work_reports_update" ON public.daily_work_reports
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── Submit / update today's (or a given day's) report ──
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_uid;
  IF v_role IS NULL OR v_role = 'admin'::public.user_role THEN
    RAISE EXCEPTION 'Only employees and managers can submit daily work reports';
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

  INSERT INTO public.daily_work_reports (user_id, report_date, content, submitted_at, updated_at)
  VALUES (v_uid, v_date, v_trimmed, timezone('utc', now()), timezone('utc', now()))
  ON CONFLICT (user_id, report_date) DO UPDATE
    SET content = EXCLUDED.content,
        updated_at = timezone('utc', now())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ── Own history (employee / manager) ──
CREATE OR REPLACE FUNCTION public.get_my_daily_work_reports(
  p_limit INTEGER DEFAULT 30
)
RETURNS TABLE (
  id UUID,
  report_date DATE,
  content TEXT,
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT r.id, r.report_date, r.content, r.submitted_at, r.updated_at
  FROM public.daily_work_reports r
  WHERE r.user_id = auth.uid()
  ORDER BY r.report_date DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 90));
END;
$$;

-- ── Admin: company-wide reports, optional department + date filters ──
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
  WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
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

-- ── Admin: department summary cards for a given date ──
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
    WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
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
    COUNT(*) FILTER (WHERE s.role = 'employee'::public.user_role)::BIGINT AS employee_count
  FROM staff s
  LEFT JOIN submitted sub ON sub.user_id = s.id
  GROUP BY s.department_id, s.dept_name
  ORDER BY s.dept_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_daily_work_report(TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_daily_work_reports(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_daily_work_reports(UUID, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_daily_report_dept_summary(DATE) TO authenticated;
