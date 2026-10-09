-- Shift duration = SUM of every visit (merged overlaps), one shared function.
-- Re-runnable. LAST in apply-all-migrations.mjs.
-- Does NOT change check-in/out rules, manual clock, windows, KPIs, leave, etc.
-- Does NOT edit or delete attendance_records or visit segments.

-- ---------------------------------------------------------------------------
-- Effective end of a visit (open → now, capped at shift end + 1 hour)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_visit_effective_end(
  p_user_id uuid,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_now timestamptz DEFAULT timezone('utc', now())
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_end timestamptz;
  v_cap timestamptz;
BEGIN
  IF p_clock_in IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_clock_out IS NOT NULL THEN
    IF p_clock_out > p_clock_in THEN
      RETURN p_clock_out;
    END IF;
    RETURN p_clock_in; -- zero-minute / inverted
  END IF;
  -- Open visit: count until now, never past shift end + 1 hour
  SELECT w.shift_end_utc + INTERVAL '1 hour'
    INTO v_cap
  FROM public.attendance_window_for_user(p_user_id, p_clock_in) w
  LIMIT 1;
  v_end := p_now;
  IF v_cap IS NOT NULL AND v_end > v_cap THEN
    v_end := v_cap;
  END IF;
  IF v_end < p_clock_in THEN
    RETURN p_clock_in;
  END IF;
  RETURN v_end;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_visit_effective_end(uuid, timestamptz, timestamptz, timestamptz)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared SSOT: sum of visit durations for a shift date (overlap-merged)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_shift_total_minutes(
  p_user_id uuid,
  p_shift_date date,
  p_now timestamptz DEFAULT timezone('utc', now())
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_total integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_shift_date IS NULL THEN
    RETURN 0;
  END IF;

  WITH raw AS (
    SELECT
      vs.clock_in_at AS t_start,
      public.attendance_visit_effective_end(
        p_user_id, vs.clock_in_at, vs.clock_out_at, p_now
      ) AS t_end
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
      AND vs.clock_in_at IS NOT NULL
      AND (
        vs.attendance_date = p_shift_date
        OR public.resolve_shift_attendance_date(p_user_id, vs.clock_in_at) = p_shift_date
      )
  ),
  ordered AS (
    SELECT t_start, t_end
    FROM raw
    WHERE t_end IS NOT NULL AND t_end >= t_start
    ORDER BY t_start
  ),
  marked AS (
    SELECT
      t_start,
      t_end,
      CASE
        WHEN t_start <= MAX(t_end) OVER (
          ORDER BY t_start
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) THEN 0
        ELSE 1
      END AS new_grp
    FROM ordered
  ),
  grouped AS (
    SELECT
      t_start,
      t_end,
      SUM(new_grp) OVER (ORDER BY t_start) AS grp
    FROM marked
  ),
  merged AS (
    SELECT MIN(t_start) AS t_start, MAX(t_end) AS t_end
    FROM grouped
    GROUP BY grp
  )
  SELECT COALESCE(
    SUM(
      GREATEST(0, ROUND(EXTRACT(EPOCH FROM (t_end - t_start)) / 60.0))::integer
    ),
    0
  )::integer
  INTO v_total
  FROM merged;

  RETURN COALESCE(v_total, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_shift_total_minutes(uuid, date, timestamptz)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.attendance_day_total_minutes(
  p_user_id uuid,
  p_date date,
  p_now timestamptz DEFAULT timezone('utc', now())
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.attendance_shift_total_minutes(p_user_id, p_date, p_now);
$$;

GRANT EXECUTE ON FUNCTION public.attendance_day_total_minutes(uuid, date, timestamptz)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Day / shift summary for UI (first in, last out, total, visit count)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_shift_day_summary(
  p_user_id uuid,
  p_shift_date date,
  p_now timestamptz DEFAULT timezone('utc', now())
)
RETURNS TABLE (
  first_clock_in timestamptz,
  last_clock_out timestamptz,
  still_present boolean,
  total_minutes integer,
  visit_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH visits AS (
    SELECT vs.clock_in_at, vs.clock_out_at
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
      AND vs.clock_in_at IS NOT NULL
      AND (
        vs.attendance_date = p_shift_date
        OR public.resolve_shift_attendance_date(p_user_id, vs.clock_in_at) = p_shift_date
      )
  )
  SELECT
    MIN(v.clock_in_at),
    CASE
      WHEN BOOL_OR(v.clock_out_at IS NULL) THEN NULL
      ELSE MAX(v.clock_out_at) FILTER (
        WHERE v.clock_out_at IS NOT NULL AND v.clock_out_at >= v.clock_in_at
      )
    END,
    BOOL_OR(v.clock_out_at IS NULL),
    public.attendance_shift_total_minutes(p_user_id, p_shift_date, p_now),
    COUNT(*)::integer
  FROM visits v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_shift_day_summary(uuid, date, timestamptz)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- History duration helper → always the shared shift total when visits exist
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_history_work_minutes(
  p_user_id uuid,
  p_date date,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_stored integer,
  p_source text,
  p_shift_mins integer
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_seg integer;
  v_has_visits boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
      AND (
        vs.attendance_date = p_date
        OR public.resolve_shift_attendance_date(p_user_id, vs.clock_in_at) = p_date
      )
  ) INTO v_has_visits;

  v_seg := public.attendance_shift_total_minutes(p_user_id, p_date);
  IF v_has_visits THEN
    RETURN v_seg;
  END IF;
  IF p_stored IS NOT NULL AND p_stored > 0 THEN
    RETURN p_stored;
  END IF;
  IF p_clock_in IS NOT NULL AND p_clock_out IS NOT NULL AND p_clock_out > p_clock_in THEN
    RETURN GREATEST(0, (EXTRACT(EPOCH FROM (p_clock_out - p_clock_in)) / 60)::integer);
  END IF;
  IF p_source IS DISTINCT FROM 'geo' AND p_shift_mins IS NOT NULL AND p_shift_mins > 0 THEN
    RETURN p_shift_mins;
  END IF;
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_history_work_minutes(
  uuid, date, timestamptz, timestamptz, integer, text, integer
) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Visits list: duration = out − in (open capped); same shift-date grouping
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_attendance_visits(p_date date DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  visit_number integer,
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  work_minutes integer,
  site_name text,
  notes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_shift_date date;
  v_now timestamptz := timezone('utc', now());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_shift_date := COALESCE(p_date, public.resolve_shift_attendance_date(v_uid, v_now));

  RETURN QUERY
  SELECT
    vs.id,
    ROW_NUMBER() OVER (ORDER BY vs.clock_in_at ASC)::integer AS visit_number,
    vs.clock_in_at,
    vs.clock_out_at,
    GREATEST(
      0,
      ROUND(EXTRACT(EPOCH FROM (
        public.attendance_visit_effective_end(v_uid, vs.clock_in_at, vs.clock_out_at, v_now)
        - vs.clock_in_at
      )) / 60.0)::integer
    ) AS work_minutes,
    vs.site_name,
    vs.notes
  FROM public.attendance_visit_segments vs
  WHERE vs.user_id = v_uid
    AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
    AND (
      vs.attendance_date = v_shift_date
      OR public.resolve_shift_attendance_date(v_uid, vs.clock_in_at) = v_shift_date
    )
  ORDER BY vs.clock_in_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_attendance_visits(date) TO authenticated;

-- ---------------------------------------------------------------------------
-- History RPCs: same auth as live; visit_count out; visits via shift summary
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_attendance_history(integer, integer, uuid);

CREATE FUNCTION public.get_attendance_history(
  p_year integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
  p_month integer DEFAULT NULL::integer,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE (
  id uuid,
  attendance_date date,
  status attendance_status,
  approval_status approval_status,
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  attendance_source text,
  work_minutes integer,
  shift_name text,
  notes text,
  visit_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid;
  v_role public.user_role;
  v_start date;
  v_end date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;
  v_target := COALESCE(p_user_id, v_uid);

  IF v_target <> v_uid THEN
    IF v_role = 'manager'::public.user_role THEN
      IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_target AND u.manager_id = v_uid) THEN
        RAISE EXCEPTION 'Not authorized';
      END IF;
    ELSIF v_role NOT IN ('admin'::public.user_role, 'hr'::public.user_role) THEN
      RAISE EXCEPTION 'Not authorized';
    END IF;
  END IF;

  PERFORM public.close_open_attendance_if_shift_ended(v_target, NULL, NULL);

  IF p_month IS NULL THEN
    v_start := make_date(p_year, 1, 1);
    v_end := make_date(p_year, 12, 31);
  ELSE
    v_start := make_date(p_year, p_month, 1);
    v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::date;
  END IF;

  RETURN QUERY
  SELECT
    q.rid,
    q.rdate,
    q.rstatus,
    q.rapproval,
    q.rin,
    q.rout,
    q.rsource,
    q.rmins,
    q.rshift,
    q.rnotes,
    q.rvisits
  FROM (
    SELECT
      ar.id AS rid,
      ar.attendance_date AS rdate,
      ar.status AS rstatus,
      ar.approval_status AS rapproval,
      COALESCE(summ.first_clock_in, ar.clock_in_at) AS rin,
      public.attendance_resolve_history_clock_out(
        COALESCE(summ.first_clock_in, ar.clock_in_at),
        ar.clock_out_at,
        summ.last_clock_out,
        ar.work_minutes,
        public.attendance_history_still_open(
          ar.user_id,
          COALESCE(summ.first_clock_in, ar.clock_in_at),
          COALESCE(summ.still_present, false)
        ),
        COALESCE(summ.visit_count, 0)
      ) AS rout,
      ar.attendance_source AS rsource,
      public.attendance_history_work_minutes(
        ar.user_id,
        ar.attendance_date,
        COALESCE(summ.first_clock_in, ar.clock_in_at),
        public.attendance_resolve_history_clock_out(
          COALESCE(summ.first_clock_in, ar.clock_in_at),
          ar.clock_out_at,
          summ.last_clock_out,
          ar.work_minutes,
          public.attendance_history_still_open(
            ar.user_id,
            COALESCE(summ.first_clock_in, ar.clock_in_at),
            COALESCE(summ.still_present, false)
          ),
          COALESCE(summ.visit_count, 0)
        ),
        ar.work_minutes,
        ar.attendance_source,
        asg.shift_mins
      ) AS rmins,
      COALESCE(ws.name, asg.shift_name) AS rshift,
      ar.notes AS rnotes,
      COALESCE(summ.visit_count, 0) AS rvisits
    FROM public.attendance_records ar
    LEFT JOIN public.work_shifts ws ON ws.id = ar.shift_id
    LEFT JOIN LATERAL (
      SELECT
        ws2.name AS shift_name,
        GREATEST(
          1,
          (
            (EXTRACT(HOUR FROM ws2.end_time)::integer * 60 + EXTRACT(MINUTE FROM ws2.end_time)::integer)
            - (EXTRACT(HOUR FROM ws2.start_time)::integer * 60 + EXTRACT(MINUTE FROM ws2.start_time)::integer)
            + CASE
                WHEN COALESCE(ws2.crosses_midnight, false)
                  OR (EXTRACT(HOUR FROM ws2.end_time)::integer * 60 + EXTRACT(MINUTE FROM ws2.end_time)::integer)
                     <= (EXTRACT(HOUR FROM ws2.start_time)::integer * 60 + EXTRACT(MINUTE FROM ws2.start_time)::integer)
                THEN 24 * 60
                ELSE 0
              END
          )
        ) AS shift_mins
      FROM public.employee_shift_assignments esa
      JOIN public.work_shifts ws2 ON ws2.id = esa.shift_id
      WHERE esa.user_id = ar.user_id
        AND esa.effective_from <= ar.attendance_date
        AND (esa.effective_to IS NULL OR esa.effective_to >= ar.attendance_date)
      ORDER BY esa.effective_from DESC
      LIMIT 1
    ) asg ON true
    LEFT JOIN LATERAL (
      SELECT * FROM public.attendance_shift_day_summary(ar.user_id, ar.attendance_date)
    ) summ ON true
    WHERE ar.user_id = v_target
      AND ar.attendance_date BETWEEN v_start AND v_end
  ) q
  ORDER BY q.rdate DESC, q.rin DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_attendance_history(integer, integer, uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.get_team_attendance_history(integer, integer, uuid, uuid, text);

CREATE FUNCTION public.get_team_attendance_history(
  p_year integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
  p_month integer DEFAULT NULL::integer,
  p_user_id uuid DEFAULT NULL::uuid,
  p_department_id uuid DEFAULT NULL::uuid,
  p_scope text DEFAULT 'self'::text
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  employee_name text,
  employee_role text,
  department_name text,
  attendance_date date,
  status attendance_status,
  approval_status approval_status,
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  attendance_source text,
  work_minutes integer,
  shift_name text,
  notes text,
  visit_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.user_role;
  v_company uuid;
  v_start date;
  v_end date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT u.role, u.company_id INTO v_role, v_company FROM public.users u WHERE u.id = v_uid;
  IF v_company IS NULL THEN RAISE EXCEPTION 'No company context'; END IF;

  IF p_month IS NULL THEN
    v_start := make_date(p_year, 1, 1);
    v_end := make_date(p_year, 12, 31);
  ELSE
    v_start := make_date(p_year, p_month, 1);
    v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::date;
  END IF;

  RETURN QUERY
  SELECT
    q.rid,
    q.ruser,
    q.rname,
    q.rrole,
    q.rdept,
    q.rdate,
    q.rstatus,
    q.rapproval,
    q.rin,
    q.rout,
    q.rsource,
    q.rmins,
    q.rshift,
    q.rnotes,
    q.rvisits
  FROM (
    SELECT
      ar.id AS rid,
      ar.user_id AS ruser,
      u.full_name AS rname,
      u.role::text AS rrole,
      d.name AS rdept,
      ar.attendance_date AS rdate,
      ar.status AS rstatus,
      ar.approval_status AS rapproval,
      COALESCE(summ.first_clock_in, ar.clock_in_at) AS rin,
      public.attendance_resolve_history_clock_out(
        COALESCE(summ.first_clock_in, ar.clock_in_at),
        ar.clock_out_at,
        summ.last_clock_out,
        ar.work_minutes,
        public.attendance_history_still_open(
          ar.user_id,
          COALESCE(summ.first_clock_in, ar.clock_in_at),
          COALESCE(summ.still_present, false)
        ),
        COALESCE(summ.visit_count, 0)
      ) AS rout,
      ar.attendance_source AS rsource,
      public.attendance_history_work_minutes(
        ar.user_id,
        ar.attendance_date,
        COALESCE(summ.first_clock_in, ar.clock_in_at),
        public.attendance_resolve_history_clock_out(
          COALESCE(summ.first_clock_in, ar.clock_in_at),
          ar.clock_out_at,
          summ.last_clock_out,
          ar.work_minutes,
          public.attendance_history_still_open(
            ar.user_id,
            COALESCE(summ.first_clock_in, ar.clock_in_at),
            COALESCE(summ.still_present, false)
          ),
          COALESCE(summ.visit_count, 0)
        ),
        ar.work_minutes,
        ar.attendance_source,
        asg.shift_mins
      ) AS rmins,
      COALESCE(ws.name, asg.shift_name) AS rshift,
      ar.notes AS rnotes,
      COALESCE(summ.visit_count, 0) AS rvisits
    FROM public.attendance_records ar
    JOIN public.users u ON u.id = ar.user_id
    LEFT JOIN public.departments d ON d.id = u.department_id
    LEFT JOIN public.work_shifts ws ON ws.id = ar.shift_id
    LEFT JOIN LATERAL (
      SELECT
        ws2.name AS shift_name,
        GREATEST(
          1,
          (
            (EXTRACT(HOUR FROM ws2.end_time)::integer * 60 + EXTRACT(MINUTE FROM ws2.end_time)::integer)
            - (EXTRACT(HOUR FROM ws2.start_time)::integer * 60 + EXTRACT(MINUTE FROM ws2.start_time)::integer)
            + CASE
                WHEN COALESCE(ws2.crosses_midnight, false)
                  OR (EXTRACT(HOUR FROM ws2.end_time)::integer * 60 + EXTRACT(MINUTE FROM ws2.end_time)::integer)
                     <= (EXTRACT(HOUR FROM ws2.start_time)::integer * 60 + EXTRACT(MINUTE FROM ws2.start_time)::integer)
                THEN 24 * 60
                ELSE 0
              END
          )
        ) AS shift_mins
      FROM public.employee_shift_assignments esa
      JOIN public.work_shifts ws2 ON ws2.id = esa.shift_id
      WHERE esa.user_id = ar.user_id
        AND esa.effective_from <= ar.attendance_date
        AND (esa.effective_to IS NULL OR esa.effective_to >= ar.attendance_date)
      ORDER BY esa.effective_from DESC
      LIMIT 1
    ) asg ON true
    LEFT JOIN LATERAL (
      SELECT * FROM public.attendance_shift_day_summary(ar.user_id, ar.attendance_date)
    ) summ ON true
    WHERE u.company_id = v_company
      AND ar.attendance_date BETWEEN v_start AND v_end
      AND (
        (p_scope = 'self' AND ar.user_id = COALESCE(p_user_id, v_uid))
        OR (
          p_scope = 'team'
          AND v_role = 'manager'::public.user_role
          AND (ar.user_id = v_uid OR u.manager_id = v_uid)
        )
        OR (
          p_scope = 'department'
          AND p_department_id IS NOT NULL
          AND u.department_id = p_department_id
          AND (
            public.is_admin(v_uid)
            OR public.is_hr(v_uid)
            OR (
              v_role = 'manager'::public.user_role
              AND u.department_id = public.user_department_id(v_uid)
            )
          )
        )
        OR (
          p_scope = 'company'
          AND (public.is_admin(v_uid) OR public.is_hr(v_uid))
          AND (p_department_id IS NULL OR u.department_id = p_department_id)
        )
      )
      AND (
        ar.user_id = v_uid
        OR public.is_admin(v_uid)
        OR public.is_hr(v_uid)
        OR (v_role = 'manager'::public.user_role AND (u.manager_id = v_uid OR u.id = v_uid))
        OR (v_role = 'manager'::public.user_role AND p_scope = 'department' AND u.department_id = public.user_department_id(v_uid))
      )
  ) q
  ORDER BY q.rdate DESC, q.rname, q.rin DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_attendance_history(integer, integer, uuid, uuid, text)
  TO authenticated;
