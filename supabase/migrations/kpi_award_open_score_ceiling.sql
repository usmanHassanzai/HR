-- KPI gift ceilings: monthly scores may exceed 100 (task points).
-- Dinner / surprise gifts use a minimum score (95+), not a hard 100 cap.
-- Movie tickets keep the 85–90 "good performer" band.

CREATE OR REPLACE FUNCTION public.kpi_award_in_band(p_score NUMERIC, p_min NUMERIC, p_max NUMERIC)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT p_score IS NOT NULL
       AND p_score >= p_min
       AND (
            p_max IS NULL
            OR p_max >= 9999
            OR p_score <= p_max
       );
$$;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'kpi_award_config'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%dinner_max_pct%'
    LOOP
        EXECUTE format('ALTER TABLE public.kpi_award_config DROP CONSTRAINT IF EXISTS %I', r.conname);
    END LOOP;

    FOR r IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'kpi_award_config'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%gift_max_pct%'
    LOOP
        EXECUTE format('ALTER TABLE public.kpi_award_config DROP CONSTRAINT IF EXISTS %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE public.kpi_award_config
    ALTER COLUMN dinner_max_pct SET DEFAULT 9999,
    ALTER COLUMN gift_max_pct SET DEFAULT 9999;

UPDATE public.kpi_award_config
SET dinner_max_pct = 9999,
    gift_max_pct = 9999,
    updated_at = timezone('utc'::text, now())
WHERE dinner_max_pct <= 100
   OR gift_max_pct <= 100;

CREATE OR REPLACE FUNCTION public.kpi_award_band_label(p_min NUMERIC, p_max NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_max IS NULL OR p_max >= 9999 THEN trim(to_char(p_min, 'FM999999990.#######')) || '+'
        ELSE trim(to_char(p_min, 'FM999999990.#######')) || '–' || trim(to_char(p_max, 'FM999999990.#######'))
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
    v_gift_max NUMERIC;
    v_dinner_band TEXT;
    v_gift_band TEXT;
    v_movie_band TEXT;
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
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 9999);
    v_latest := public.kpi_award_month_score(v_uid, v_month);
    v_movie_band := public.kpi_award_band_label(v_cfg.movie_min_pct, v_cfg.movie_max_pct);
    v_dinner_band := public.kpi_award_band_label(v_cfg.dinner_min_pct, v_cfg.dinner_max_pct);
    v_gift_band := public.kpi_award_band_label(v_cfg.gift_min_pct, v_gift_max);

    v_movie := public.kpi_award_consecutive_months(v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets');
    v_dinner := CASE WHEN public.kpi_award_in_band(v_latest, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN 1 ELSE 0 END;
    v_gift := public.kpi_award_consecutive_months(v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift');

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
        WHEN v_movie >= v_cfg.movie_months THEN 'Qualified — waiting for approval.'
        WHEN v_movie = 0 AND v_latest IS NOT NULL THEN
            'Need ' || v_cfg.movie_months::TEXT || ' months in a row at score ' || v_movie_band
            || '. This month: ' || round(v_latest, 1)::TEXT || '.'
        WHEN v_movie = 0 THEN
            'Need ' || v_cfg.movie_months::TEXT || ' months in a row at score ' || v_movie_band || '.'
        ELSE v_movie::TEXT || ' of ' || v_cfg.movie_months::TEXT || ' months at score ' || v_movie_band || '.'
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
    progress_pct := CASE
        WHEN v_dinner = 1 THEN 100
        WHEN v_latest IS NULL THEN 0
        ELSE LEAST(100, ROUND(COALESCE(v_latest, 0) / NULLIF(v_cfg.dinner_min_pct, 0) * 100, 1))
    END;
    qualified := v_dinner = 1;
    hint := CASE
        WHEN v_dinner = 1 THEN 'You met this month''s target — waiting for approval.'
        WHEN v_latest IS NULL THEN 'Reach a KPI score of ' || v_dinner_band || ' in any one month.'
        WHEN v_latest < v_cfg.dinner_min_pct THEN
            'This month''s score is ' || round(v_latest, 1)::TEXT
            || '. Reach ' || v_dinner_band || ' to qualify.'
        ELSE
            'This month''s score is ' || round(v_latest, 1)::TEXT
            || '. This gift is for scores in the ' || v_dinner_band || ' range.'
    END;
    RETURN NEXT;

    rule_key := 'surprise_gift';
    reward_name := v_cfg.gift_reward_name;
    min_pct := v_cfg.gift_min_pct;
    max_pct := v_gift_max;
    required_months := v_cfg.gift_months;
    current_months := LEAST(v_gift, v_cfg.gift_months);
    months_to_go := GREATEST(v_cfg.gift_months - v_gift, 0);
    latest_score := v_latest;
    progress_pct := LEAST(100, ROUND((v_gift::NUMERIC / NULLIF(v_cfg.gift_months, 0)) * 100, 1));
    qualified := v_gift >= v_cfg.gift_months;
    hint := CASE
        WHEN v_gift >= v_cfg.gift_months THEN 'Qualified — waiting for approval.'
        WHEN v_gift = 0 AND v_latest IS NOT NULL THEN
            'Need ' || v_cfg.gift_months::TEXT || ' months in a row at score ' || v_gift_band
            || '. This month: ' || round(v_latest, 1)::TEXT || '.'
        WHEN v_gift = 0 THEN
            'Need ' || v_cfg.gift_months::TEXT || ' months in a row at score ' || v_gift_band || '.'
        ELSE v_gift::TEXT || ' of ' || v_cfg.gift_months::TEXT || ' months at score ' || v_gift_band || '.'
    END;
    RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kpi_award_in_band(NUMERIC, NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_award_band_label(NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
