-- Automatic KPI performance awards (movie tickets / dinner / surprise gift).
-- Thresholds are per-company and editable by Admin or HR.

CREATE TABLE IF NOT EXISTS public.kpi_award_config (
    company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
    movie_min_pct NUMERIC NOT NULL DEFAULT 85 CHECK (movie_min_pct >= 0 AND movie_min_pct <= 100),
    movie_max_pct NUMERIC NOT NULL DEFAULT 90 CHECK (movie_max_pct >= 0 AND movie_max_pct <= 100),
    movie_months INTEGER NOT NULL DEFAULT 3 CHECK (movie_months BETWEEN 1 AND 24),
    movie_reward_name TEXT NOT NULL DEFAULT '2 Movie Tickets',
    dinner_min_pct NUMERIC NOT NULL DEFAULT 95 CHECK (dinner_min_pct >= 0 AND dinner_min_pct <= 100),
    dinner_max_pct NUMERIC NOT NULL DEFAULT 100 CHECK (dinner_max_pct >= 0 AND dinner_max_pct <= 100),
    dinner_months INTEGER NOT NULL DEFAULT 1 CHECK (dinner_months BETWEEN 1 AND 24),
    dinner_reward_name TEXT NOT NULL DEFAULT '2 Person Dinner Voucher',
    gift_min_pct NUMERIC NOT NULL DEFAULT 95 CHECK (gift_min_pct >= 0 AND gift_min_pct <= 100),
    gift_months INTEGER NOT NULL DEFAULT 6 CHECK (gift_months BETWEEN 1 AND 24),
    gift_reward_name TEXT NOT NULL DEFAULT 'Surprise Gift',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.kpi_award_qualifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    rule_key TEXT NOT NULL CHECK (rule_key IN ('movie_tickets', 'dinner_voucher', 'surprise_gift')),
    reward_name TEXT NOT NULL,
    detail TEXT NOT NULL,
    period_end DATE NOT NULL,
    months_met INTEGER NOT NULL DEFAULT 1,
    latest_score NUMERIC,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'issued', 'dismissed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    decided_at TIMESTAMPTZ,
    decided_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    UNIQUE (employee_id, rule_key, period_end)
);

CREATE INDEX IF NOT EXISTS idx_kpi_award_qual_company_status
    ON public.kpi_award_qualifications (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kpi_award_qual_employee
    ON public.kpi_award_qualifications (employee_id, created_at DESC);

ALTER TABLE public.kpi_award_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_award_qualifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.kpi_award_config FROM anon, public;
REVOKE ALL ON TABLE public.kpi_award_qualifications FROM anon, public;
GRANT SELECT ON TABLE public.kpi_award_config TO authenticated;
GRANT SELECT ON TABLE public.kpi_award_qualifications TO authenticated;

DROP POLICY IF EXISTS kpi_award_config_select ON public.kpi_award_config;
CREATE POLICY kpi_award_config_select ON public.kpi_award_config
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS kpi_award_qual_select ON public.kpi_award_qualifications;
CREATE POLICY kpi_award_qual_select ON public.kpi_award_qualifications
  FOR SELECT TO authenticated
  USING (
    employee_id = auth.uid()
    OR (public.can_manage_org_shifts(auth.uid()) AND company_id = public.current_company_id())
  );

CREATE OR REPLACE FUNCTION public.ensure_kpi_award_config(p_company_id UUID)
RETURNS public.kpi_award_config
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.kpi_award_config;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION 'Company is required';
    END IF;
    INSERT INTO public.kpi_award_config (company_id)
    VALUES (p_company_id)
    ON CONFLICT (company_id) DO NOTHING;
    SELECT * INTO v_row FROM public.kpi_award_config WHERE company_id = p_company_id;
    RETURN v_row;
END;
$$;

-- Weighted manager-rated KPI score for a calendar month (Asia/Karachi). NULL if unrated.
CREATE OR REPLACE FUNCTION public.user_month_kpi_score(p_user_id UUID, p_month DATE)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH bounds AS (
        SELECT date_trunc('month', p_month)::DATE AS m0,
               (date_trunc('month', p_month) + INTERVAL '1 month - 1 day')::DATE AS m1
    ),
    rated AS (
        SELECT
            COALESCE(k.weight, 0)::NUMERIC AS w,
            COALESCE(
                public.kpi_rating_score(k.kpi_category, k.manager_rating),
                k.supervisor_score_pct
            )::NUMERIC AS s
        FROM public.kpis k, bounds b
        WHERE k.user_id = p_user_id
          AND (k.start_date IS NULL OR k.start_date <= b.m1)
          AND (k.end_date IS NULL OR k.end_date >= b.m0)
          AND COALESCE(
                public.kpi_rating_score(k.kpi_category, k.manager_rating),
                k.supervisor_score_pct
              ) IS NOT NULL
          AND COALESCE(k.weight, 0) > 0
    )
    SELECT CASE
        WHEN COALESCE(SUM(w), 0) <= 0 THEN NULL
        ELSE ROUND(SUM(s * w) / SUM(w), 2)
    END
    FROM rated;
$$;

CREATE OR REPLACE FUNCTION public.kpi_award_month_score(p_user_id UUID, p_month DATE)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc('month', p_month)::DATE;
    v_score NUMERIC;
BEGIN
    SELECT pl.kpi_score INTO v_score
    FROM public.points_ledger pl
    WHERE pl.employee_id = p_user_id
      AND date_trunc('month', pl.month)::DATE = v_month
    LIMIT 1;
    IF v_score IS NOT NULL THEN
        RETURN ROUND(v_score, 2);
    END IF;
    RETURN public.user_month_kpi_score(p_user_id, v_month);
END;
$$;

CREATE OR REPLACE FUNCTION public.kpi_award_in_band(p_score NUMERIC, p_min NUMERIC, p_max NUMERIC)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT p_score IS NOT NULL AND p_score >= p_min AND p_score <= p_max;
$$;

CREATE OR REPLACE FUNCTION public.kpi_award_consecutive_months(
    p_user_id UUID,
    p_min NUMERIC,
    p_max NUMERIC,
    p_from DATE DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cursor DATE := date_trunc(
        'month',
        COALESCE(p_from, (timezone('Asia/Karachi', now()))::DATE)
    )::DATE;
    v_score NUMERIC;
    v_count INTEGER := 0;
    v_i INTEGER;
BEGIN
    v_score := public.kpi_award_month_score(p_user_id, v_cursor);
    IF v_score IS NULL THEN
        v_cursor := (v_cursor - INTERVAL '1 month')::DATE;
    END IF;
    FOR v_i IN 1..24 LOOP
        v_score := public.kpi_award_month_score(p_user_id, v_cursor);
        EXIT WHEN NOT public.kpi_award_in_band(v_score, p_min, p_max);
        v_count := v_count + 1;
        v_cursor := (v_cursor - INTERVAL '1 month')::DATE;
    END LOOP;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_company_award_staff(
    p_company_id UUID,
    p_title TEXT,
    p_message TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID;
BEGIN
    FOR v_uid IN
        SELECT u.id
        FROM public.users u
        WHERE u.company_id = p_company_id
          AND u.is_demo = false
          AND COALESCE(u.is_platform_owner, false) = false
          AND u.role::text IN ('admin', 'hr')
    LOOP
        PERFORM public.create_system_notification(v_uid, p_title, p_message, 'alert');
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_kpi_awards(p_company_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := COALESCE(p_company_id, public.current_company_id());
    v_cfg public.kpi_award_config;
    v_emp RECORD;
    v_cursor DATE;
    v_score NUMERIC;
    v_streak INTEGER;
    v_inserted INTEGER := 0;
    v_detail TEXT;
    v_name TEXT;
BEGIN
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'Account not linked to a company';
    END IF;
    IF auth.uid() IS NOT NULL
       AND NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins and HR can run the KPI award check';
    END IF;

    v_cfg := public.ensure_kpi_award_config(v_company);
    v_cursor := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;

    FOR v_emp IN
        SELECT u.id, u.full_name
        FROM public.users u
        WHERE u.company_id = v_company
          AND u.is_demo = false
          AND COALESCE(u.is_platform_owner, false) = false
          AND u.role::text IN ('employee', 'manager')
    LOOP
        -- Dinner: 95–100% in a single month (latest scored month)
        v_score := public.kpi_award_month_score(v_emp.id, v_cursor);
        IF v_score IS NULL THEN
            v_score := public.kpi_award_month_score(v_emp.id, (v_cursor - INTERVAL '1 month')::DATE);
        END IF;
        IF public.kpi_award_in_band(v_score, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
            v_detail := v_emp.full_name || ' qualifies for: ' || v_cfg.dinner_reward_name
                || ' — ' || round(v_score, 1)::TEXT || '% KPI in a single month ('
                || v_cfg.dinner_min_pct::TEXT || '–' || v_cfg.dinner_max_pct::TEXT || '%).';
            INSERT INTO public.kpi_award_qualifications (
                company_id, employee_id, rule_key, reward_name, detail, period_end, months_met, latest_score
            )
            VALUES (
                v_company, v_emp.id, 'dinner_voucher', v_cfg.dinner_reward_name, v_detail,
                CASE WHEN public.kpi_award_month_score(v_emp.id, v_cursor) IS NOT NULL THEN v_cursor
                     ELSE (v_cursor - INTERVAL '1 month')::DATE END,
                1, v_score
            )
            ON CONFLICT (employee_id, rule_key, period_end) DO NOTHING;
            IF FOUND THEN
                v_inserted := v_inserted + 1;
                PERFORM public.notify_company_award_staff(v_company, 'KPI reward: ' || v_emp.full_name, v_detail);
            END IF;
        END IF;

        -- Movie tickets: 85–90% for N consecutive months
        v_streak := public.kpi_award_consecutive_months(v_emp.id, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_cursor);
        IF v_streak >= v_cfg.movie_months AND (v_streak % v_cfg.movie_months) = 0 THEN
            v_detail := v_emp.full_name || ' qualifies for: ' || v_cfg.movie_reward_name
                || ' — ' || v_cfg.movie_min_pct::TEXT || '–' || v_cfg.movie_max_pct::TEXT
                || '% KPI for ' || v_cfg.movie_months::TEXT || ' consecutive months.';
            INSERT INTO public.kpi_award_qualifications (
                company_id, employee_id, rule_key, reward_name, detail, period_end, months_met, latest_score
            )
            VALUES (
                v_company, v_emp.id, 'movie_tickets', v_cfg.movie_reward_name, v_detail, v_cursor,
                v_streak, public.kpi_award_month_score(v_emp.id, v_cursor)
            )
            ON CONFLICT (employee_id, rule_key, period_end) DO NOTHING;
            IF FOUND THEN
                v_inserted := v_inserted + 1;
                PERFORM public.notify_company_award_staff(v_company, 'KPI reward: ' || v_emp.full_name, v_detail);
            END IF;
        END IF;

        -- Surprise gift: 95%+ for N consecutive months
        v_streak := public.kpi_award_consecutive_months(v_emp.id, v_cfg.gift_min_pct, 100, v_cursor);
        IF v_streak >= v_cfg.gift_months AND (v_streak % v_cfg.gift_months) = 0 THEN
            v_detail := v_emp.full_name || ' qualifies for: ' || v_cfg.gift_reward_name
                || ' — ' || v_cfg.gift_min_pct::TEXT || '%+ KPI for '
                || v_cfg.gift_months::TEXT || ' consecutive months.';
            INSERT INTO public.kpi_award_qualifications (
                company_id, employee_id, rule_key, reward_name, detail, period_end, months_met, latest_score
            )
            VALUES (
                v_company, v_emp.id, 'surprise_gift', v_cfg.gift_reward_name, v_detail, v_cursor,
                v_streak, public.kpi_award_month_score(v_emp.id, v_cursor)
            )
            ON CONFLICT (employee_id, rule_key, period_end) DO NOTHING;
            IF FOUND THEN
                v_inserted := v_inserted + 1;
                PERFORM public.notify_company_award_staff(v_company, 'KPI reward: ' || v_emp.full_name, v_detail);
            END IF;
        END IF;
    END LOOP;

    RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_kpi_awards_all_companies()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_c UUID;
    v_n INTEGER := 0;
BEGIN
    FOR v_c IN
        SELECT id FROM public.companies WHERE status = 'active'::public.company_status
    LOOP
        v_n := v_n + COALESCE(public.evaluate_kpi_awards(v_c), 0);
    END LOOP;
    RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_kpi_award_config()
RETURNS SETOF public.kpi_award_config
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := public.current_company_id();
BEGIN
    IF v_company IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY SELECT * FROM public.ensure_kpi_award_config(v_company);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_kpi_award_config(
    p_movie_min NUMERIC,
    p_movie_max NUMERIC,
    p_movie_months INTEGER,
    p_movie_name TEXT,
    p_dinner_min NUMERIC,
    p_dinner_max NUMERIC,
    p_dinner_months INTEGER,
    p_dinner_name TEXT,
    p_gift_min NUMERIC,
    p_gift_months INTEGER,
    p_gift_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := public.current_company_id();
BEGIN
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;
    IF NOT public.can_manage_org_shifts(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins and HR can change award settings';
    END IF;
    IF p_movie_min > p_movie_max OR p_dinner_min > p_dinner_max THEN
        RAISE EXCEPTION 'Minimum percent cannot be greater than maximum';
    END IF;
    PERFORM public.ensure_kpi_award_config(v_company);
    UPDATE public.kpi_award_config SET
        movie_min_pct = p_movie_min,
        movie_max_pct = p_movie_max,
        movie_months = p_movie_months,
        movie_reward_name = NULLIF(trim(p_movie_name), ''),
        dinner_min_pct = p_dinner_min,
        dinner_max_pct = p_dinner_max,
        dinner_months = GREATEST(1, p_dinner_months),
        dinner_reward_name = NULLIF(trim(p_dinner_name), ''),
        gift_min_pct = p_gift_min,
        gift_months = p_gift_months,
        gift_reward_name = NULLIF(trim(p_gift_name), ''),
        updated_at = timezone('utc'::text, now()),
        updated_by = auth.uid()
    WHERE company_id = v_company;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_kpi_award_status(p_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.kpi_award_qualifications%ROWTYPE;
BEGIN
    IF p_status NOT IN ('pending', 'approved', 'issued', 'dismissed') THEN
        RAISE EXCEPTION 'Invalid status';
    END IF;
    IF NOT public.can_manage_org_shifts(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins and HR can update award status';
    END IF;
    SELECT * INTO v_row FROM public.kpi_award_qualifications WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Award not found'; END IF;
    IF v_row.company_id IS DISTINCT FROM public.current_company_id() THEN
        RAISE EXCEPTION 'Award is not in your company';
    END IF;
    UPDATE public.kpi_award_qualifications
    SET status = p_status, decided_at = timezone('utc'::text, now()), decided_by = auth.uid()
    WHERE id = p_id;
    IF p_status IN ('approved', 'issued') THEN
        PERFORM public.create_system_notification(
            v_row.employee_id,
            'KPI reward ' || p_status,
            'You are confirmed for: ' || v_row.reward_name || '. HR/Admin will arrange it.',
            'info'
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_kpi_award_progress(p_user_id UUID DEFAULT NULL)
RETURNS TABLE (
    rule_key TEXT,
    reward_name TEXT,
    min_pct NUMERIC,
    max_pct NUMERIC,
    required_months INTEGER,
    current_months INTEGER,
    months_to_go INTEGER,
    latest_score NUMERIC,
    progress_pct NUMERIC,
    qualified BOOLEAN,
    hint TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := COALESCE(p_user_id, auth.uid());
    v_company UUID;
    v_cfg public.kpi_award_config;
    v_month DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
    v_latest NUMERIC;
    v_movie INT;
    v_dinner INT;
    v_gift INT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Not allowed';
    END IF;

    SELECT u.company_id INTO v_company FROM public.users u WHERE u.id = v_uid;
    IF v_company IS NULL THEN RETURN; END IF;
    v_cfg := public.ensure_kpi_award_config(v_company);
    v_latest := public.kpi_award_month_score(v_uid, v_month);
    IF v_latest IS NULL THEN
        v_latest := public.kpi_award_month_score(v_uid, (v_month - INTERVAL '1 month')::DATE);
    END IF;

    v_movie := public.kpi_award_consecutive_months(v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month);
    v_dinner := CASE WHEN public.kpi_award_in_band(v_latest, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN 1 ELSE 0 END;
    v_gift := public.kpi_award_consecutive_months(v_uid, v_cfg.gift_min_pct, 100, v_month);

    rule_key := 'movie_tickets';
    reward_name := v_cfg.movie_reward_name;
    min_pct := v_cfg.movie_min_pct;
    max_pct := v_cfg.movie_max_pct;
    required_months := v_cfg.movie_months;
    current_months := LEAST(v_movie, v_cfg.movie_months);
    months_to_go := GREATEST(v_cfg.movie_months - v_movie, 0);
    latest_score := v_latest;
    progress_pct := LEAST(100, ROUND((v_movie::NUMERIC / NULLIF(v_cfg.movie_months, 0)) * 100, 1));
    qualified := v_movie >= v_cfg.movie_months;
    hint := CASE
        WHEN v_movie >= v_cfg.movie_months THEN 'Qualified — waiting for Admin/HR to issue.'
        WHEN v_movie = 0 THEN 'Need ' || v_cfg.movie_months || ' months in a row at ' || v_cfg.movie_min_pct::INT || '–' || v_cfg.movie_max_pct::INT || '%.'
        ELSE v_movie::TEXT || '/' || v_cfg.movie_months::TEXT || ' months at ' || v_cfg.movie_min_pct::INT || '%+ — '
            || (v_cfg.movie_months - v_movie)::TEXT || ' month' || CASE WHEN v_cfg.movie_months - v_movie = 1 THEN '' ELSE 's' END || ' to go.'
    END;
    RETURN NEXT;

    rule_key := 'dinner_voucher';
    reward_name := v_cfg.dinner_reward_name;
    min_pct := v_cfg.dinner_min_pct;
    max_pct := v_cfg.dinner_max_pct;
    required_months := 1;
    current_months := v_dinner;
    months_to_go := 1 - v_dinner;
    latest_score := v_latest;
    progress_pct := CASE WHEN v_dinner = 1 THEN 100 ELSE LEAST(100, ROUND(COALESCE(v_latest, 0) / NULLIF(v_cfg.dinner_min_pct, 0) * 100, 1)) END;
    qualified := v_dinner = 1;
    hint := CASE
        WHEN v_dinner = 1 THEN 'Qualified this month — waiting for Admin/HR to issue.'
        WHEN v_latest IS NULL THEN 'Score ' || v_cfg.dinner_min_pct::INT || '–' || v_cfg.dinner_max_pct::INT || '% in one month to earn this.'
        ELSE 'This month: ' || round(v_latest, 1)::TEXT || '% (need ' || v_cfg.dinner_min_pct::INT || '–' || v_cfg.dinner_max_pct::INT || '%).'
    END;
    RETURN NEXT;

    rule_key := 'surprise_gift';
    reward_name := v_cfg.gift_reward_name;
    min_pct := v_cfg.gift_min_pct;
    max_pct := 100;
    required_months := v_cfg.gift_months;
    current_months := LEAST(v_gift, v_cfg.gift_months);
    months_to_go := GREATEST(v_cfg.gift_months - v_gift, 0);
    latest_score := v_latest;
    progress_pct := LEAST(100, ROUND((v_gift::NUMERIC / NULLIF(v_cfg.gift_months, 0)) * 100, 1));
    qualified := v_gift >= v_cfg.gift_months;
    hint := CASE
        WHEN v_gift >= v_cfg.gift_months THEN 'Qualified — waiting for Admin/HR to issue.'
        WHEN v_gift = 0 THEN 'Need ' || v_cfg.gift_months || ' months in a row at ' || v_cfg.gift_min_pct::INT || '%+.'
        ELSE v_gift::TEXT || '/' || v_cfg.gift_months::TEXT || ' months at ' || v_cfg.gift_min_pct::INT || '%+ — '
            || (v_cfg.gift_months - v_gift)::TEXT || ' month' || CASE WHEN v_cfg.gift_months - v_gift = 1 THEN '' ELSE 's' END || ' to go.'
    END;
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_kpi_award_pipeline()
RETURNS TABLE (
    qualification_id UUID,
    employee_id UUID,
    full_name TEXT,
    email TEXT,
    rule_key TEXT,
    reward_name TEXT,
    bucket TEXT,
    detail TEXT,
    current_months INTEGER,
    required_months INTEGER,
    latest_score NUMERIC,
    status TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := public.current_company_id();
    v_cfg public.kpi_award_config;
    v_month DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
    v_emp RECORD;
    v_movie INT;
    v_gift INT;
    v_latest NUMERIC;
    v_q UUID;
BEGIN
    IF NOT public.can_manage_org_shifts(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins and HR can view the award pipeline';
    END IF;
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;
    v_cfg := public.ensure_kpi_award_config(v_company);

    RETURN QUERY
    SELECT
        q.id,
        q.employee_id,
        u.full_name,
        u.email,
        q.rule_key,
        q.reward_name,
        'eligible'::TEXT,
        q.detail,
        q.months_met,
        CASE q.rule_key
            WHEN 'movie_tickets' THEN v_cfg.movie_months
            WHEN 'surprise_gift' THEN v_cfg.gift_months
            ELSE 1
        END,
        q.latest_score,
        q.status,
        q.created_at
    FROM public.kpi_award_qualifications q
    JOIN public.users u ON u.id = q.employee_id
    WHERE q.company_id = v_company
      AND q.status IN ('pending', 'approved')
    ORDER BY q.created_at DESC;

    FOR v_emp IN
        SELECT u.id, u.full_name, u.email
        FROM public.users u
        WHERE u.company_id = v_company
          AND u.is_demo = false
          AND COALESCE(u.is_platform_owner, false) = false
          AND u.role::text IN ('employee', 'manager')
    LOOP
        v_latest := public.kpi_award_month_score(v_emp.id, v_month);
        IF v_latest IS NULL THEN
            v_latest := public.kpi_award_month_score(v_emp.id, (v_month - INTERVAL '1 month')::DATE);
        END IF;

        v_movie := public.kpi_award_consecutive_months(v_emp.id, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month);
        IF v_movie > 0 AND v_movie < v_cfg.movie_months THEN
            SELECT q.id INTO v_q
            FROM public.kpi_award_qualifications q
            WHERE q.employee_id = v_emp.id AND q.rule_key = 'movie_tickets' AND q.period_end = v_month
            LIMIT 1;
            IF v_q IS NULL THEN
                employee_id := v_emp.id;
                full_name := v_emp.full_name;
                email := v_emp.email;
                qualification_id := NULL;
                rule_key := 'movie_tickets';
                reward_name := v_cfg.movie_reward_name;
                bucket := 'close';
                detail := v_emp.full_name || ' is close: ' || v_movie::TEXT || '/' || v_cfg.movie_months::TEXT
                    || ' months at ' || v_cfg.movie_min_pct::INT || '–' || v_cfg.movie_max_pct::INT || '% for '
                    || v_cfg.movie_reward_name || '.';
                current_months := v_movie;
                required_months := v_cfg.movie_months;
                latest_score := v_latest;
                status := NULL;
                created_at := NULL;
                RETURN NEXT;
            END IF;
        END IF;

        v_gift := public.kpi_award_consecutive_months(v_emp.id, v_cfg.gift_min_pct, 100, v_month);
        IF v_gift >= GREATEST(v_cfg.gift_months - 2, 1) AND v_gift < v_cfg.gift_months THEN
            SELECT q.id INTO v_q
            FROM public.kpi_award_qualifications q
            WHERE q.employee_id = v_emp.id AND q.rule_key = 'surprise_gift' AND q.period_end = v_month
            LIMIT 1;
            IF v_q IS NULL THEN
                employee_id := v_emp.id;
                full_name := v_emp.full_name;
                email := v_emp.email;
                qualification_id := NULL;
                rule_key := 'surprise_gift';
                reward_name := v_cfg.gift_reward_name;
                bucket := 'close';
                detail := v_emp.full_name || ' is close: ' || v_gift::TEXT || '/' || v_cfg.gift_months::TEXT
                    || ' months at ' || v_cfg.gift_min_pct::INT || '%+ for ' || v_cfg.gift_reward_name || '.';
                current_months := v_gift;
                required_months := v_cfg.gift_months;
                latest_score := v_latest;
                status := NULL;
                created_at := NULL;
                RETURN NEXT;
            END IF;
        END IF;

        IF v_latest IS NOT NULL
           AND v_latest >= v_cfg.dinner_min_pct - 5
           AND NOT public.kpi_award_in_band(v_latest, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
            employee_id := v_emp.id;
            full_name := v_emp.full_name;
            email := v_emp.email;
            qualification_id := NULL;
            rule_key := 'dinner_voucher';
            reward_name := v_cfg.dinner_reward_name;
            bucket := 'close';
            detail := v_emp.full_name || ' is close: ' || round(v_latest, 1)::TEXT || '% this month (need '
                || v_cfg.dinner_min_pct::INT || '–' || v_cfg.dinner_max_pct::INT || '% for '
                || v_cfg.dinner_reward_name || ').';
            current_months := 0;
            required_months := 1;
            latest_score := v_latest;
            status := NULL;
            created_at := NULL;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

-- Hook monthly points job so awards are checked whenever bonuses run.
CREATE OR REPLACE FUNCTION public.calculate_monthly_points(p_month DATE DEFAULT date_trunc('month', now())::DATE)
RETURNS TABLE(employee TEXT, score NUMERIC, points INTEGER) AS $$
DECLARE
    rec RECORD;
    v_score NUMERIC;
    v_points INTEGER;
    v_on  NUMERIC := 100;
    v_risk NUMERIC := 50;
    v_off  NUMERIC := 0;
    v_company UUID;
BEGIN
    IF public.is_demo_user(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Demo accounts cannot run the monthly points job';
    END IF;

    v_company := public.current_company_id();

    FOR rec IN
        SELECT u.id, u.email, u.full_name
        FROM public.users u
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND u.is_platform_owner = false
          AND (
              (public.is_demo_user(auth.uid()) AND u.is_demo = true)
              OR (
                  NOT public.is_demo_user(auth.uid())
                  AND u.is_demo = false
                  AND (v_company IS NULL OR u.company_id = v_company)
              )
          )
    LOOP
        SELECT COALESCE(public.user_month_kpi_score(rec.id, p_month), (
            SELECT CASE WHEN sum(k.weight) = 0 THEN 100
                        ELSE sum(CASE k.status WHEN 'on_track' THEN v_on * k.weight WHEN 'at_risk' THEN v_risk * k.weight ELSE v_off * k.weight END) / sum(k.weight)
                   END
            FROM public.kpis k WHERE k.user_id = rec.id
        ), 0) INTO v_score;
        v_score  := COALESCE(v_score, 0);
        v_points := public.monthly_points_for_score(v_score);
        INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
        VALUES (rec.id, p_month, v_score, v_points)
        ON CONFLICT (employee_id, month) DO NOTHING;
        IF v_points > 0 THEN
            PERFORM public.create_system_notification(rec.id, 'Monthly Points Awarded',
                'You earned ' || v_points || ' points this month (score: ' || round(v_score) || '%).', 'info');
        END IF;
        employee := COALESCE(rec.full_name, rec.email);
        score := v_score;
        points := v_points;
        RETURN NEXT;
    END LOOP;

    IF v_company IS NOT NULL THEN
        BEGIN
            PERFORM public.evaluate_kpi_awards(v_company);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.ensure_kpi_award_config(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_month_kpi_score(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_award_month_score(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_award_consecutive_months(UUID, NUMERIC, NUMERIC, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_kpi_awards(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_kpi_awards_all_companies() TO postgres;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_config() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_kpi_award_config(NUMERIC, NUMERIC, INTEGER, TEXT, NUMERIC, NUMERIC, INTEGER, TEXT, NUMERIC, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_kpi_award_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_pipeline() TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_monthly_points(DATE) TO authenticated;

DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('scorr-kpi-performance-awards');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
        PERFORM cron.schedule(
            'scorr-kpi-performance-awards',
            '15 1 1 * *',
            'SELECT public.evaluate_kpi_awards_all_companies()'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$outer$;

NOTIFY pgrst, 'reload schema';
