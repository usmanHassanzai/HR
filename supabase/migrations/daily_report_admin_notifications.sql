-- Notify company admins when an employee/manager submits or updates a daily work report.
-- Also enable realtime on daily_work_reports for live admin refresh.

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

  INSERT INTO public.notifications (user_id, title, message, type)
  SELECT a.id, v_title, v_message, 'info'::public.notification_type
  FROM public.users a
  WHERE a.role = 'admin'::public.user_role
    AND a.company_id IS NOT DISTINCT FROM v_company_id
    AND a.id <> v_uid;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_daily_work_report(TEXT, DATE) TO authenticated;

ALTER TABLE public.daily_work_reports REPLICA IDENTITY FULL;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_work_reports;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END $$;
