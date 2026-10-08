-- Approval notice: task approved only — no awarded weightage amount.
-- Weightage is announced on the last calendar day of the month (Asia/Karachi).

DO $patch$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.review_kpi_completion(uuid, numeric, boolean, text)'::regprocedure);
  def := replace(def,
$old$    PERFORM public.create_system_notification(
        v_emp.id,
        'KPI approved',
        'Your task "' || v_kpi.name || '" was approved with '
            || trim(to_char(v_score, '999990.99')) || '% weightage.'
            || CASE WHEN v_note IS NULL THEN '' ELSE ' Note: ' || v_note END,
        'info',
        jsonb_build_object('kind', 'kpi', 'kpiId', p_kpi_id, 'userId', v_emp.id)
    );
$old$,
$new$    PERFORM public.create_system_notification(
        v_emp.id,
        'KPI approved',
        'Your task "' || v_kpi.name || '" was approved.'
            || CASE WHEN v_note IS NULL THEN '' ELSE ' Note: ' || v_note END,
        'info',
        jsonb_build_object('kind', 'kpi', 'kpiId', p_kpi_id, 'userId', v_emp.id)
    );
$new$);
  IF def LIKE '%approved with%' AND def LIKE '%weightage.%' THEN
    RAISE EXCEPTION 'KPI approved notification still mentions weightage';
  END IF;
  IF def NOT LIKE '%was approved.%' THEN
    RAISE EXCEPTION 'KPI approved notification text did not update';
  END IF;
  EXECUTE def;
END $patch$;

CREATE OR REPLACE FUNCTION public.notify_month_end_kpi_weightage()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now_k TIMESTAMPTZ := timezone('Asia/Karachi', now());
  v_today DATE := v_now_k::date;
  v_month_start DATE := date_trunc('month', v_today)::date;
  v_month_end DATE := (date_trunc('month', v_today) + INTERVAL '1 month - 1 day')::date;
  v_month_label TEXT;
  v_count INTEGER := 0;
  r RECORD;
BEGIN
  -- Only on the last calendar day of the month in Asia/Karachi.
  IF v_today <> v_month_end THEN
    RETURN 0;
  END IF;

  v_month_label := to_char(v_today, 'FMMonth YYYY');

  FOR r IN
    SELECT
      k.id AS kpi_id,
      k.name AS kpi_name,
      k.assigned_to AS user_id,
      COALESCE(k.assigned_score, k.weight, 0)::NUMERIC AS awarded
    FROM public.kpis k
    WHERE k.assigned_to IS NOT NULL
      AND k.completion_status = 'completed'
      AND COALESCE(k.assigned_score, k.weight, 0) > 0
      AND COALESCE(
            (timezone('Asia/Karachi', k.completed_at))::date,
            k.end_date,
            (timezone('Asia/Karachi', k.created_at))::date
          ) BETWEEN v_month_start AND v_month_end
      AND NOT EXISTS (
        SELECT 1
        FROM public.notifications n
        WHERE n.user_id = k.assigned_to
          AND COALESCE(n.meta->>'kind', '') = 'kpi_weightage_reveal'
          AND COALESCE(n.meta->>'kpiId', '') = k.id::text
      )
  LOOP
    PERFORM public.create_system_notification(
      r.user_id,
      'Weightage awarded',
      'Your task "' || r.kpi_name || '" awarded '
        || trim(to_char(r.awarded, 'FM999990.99')) || '% weightage for '
        || v_month_label || '.',
      'info',
      jsonb_build_object(
        'kind', 'kpi_weightage_reveal',
        'kpiId', r.kpi_id,
        'userId', r.user_id,
        'month', to_char(v_today, 'YYYY-MM')
      )
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_month_end_kpi_weightage() TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'scorr-kpi-weightage-month-end';

    -- Hourly; the function only sends on the last Karachi calendar day, once per task.
    PERFORM cron.schedule(
      'scorr-kpi-weightage-month-end',
      '20 * * * *',
      $job$SELECT public.notify_month_end_kpi_weightage();$job$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $cron$;
