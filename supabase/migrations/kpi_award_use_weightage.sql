-- Company gifts use monthly weightage achieved (0–100%), not score points.
-- Score points can exceed 100; weightage is the % of the 100% pool completed.

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

CREATE OR REPLACE FUNCTION public.kpi_award_month_score(p_user_id UUID, p_month DATE)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc('month', p_month)::DATE;
    v_month_end DATE := (date_trunc('month', p_month) + INTERVAL '1 month - 1 day')::DATE;
    v_total INTEGER := 0;
    v_weight NUMERIC := 0;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_total
    FROM public.kpis k
    WHERE k.user_id = p_user_id
      AND COALESCE(k.start_date, k.created_at::DATE) <= v_month_end
      AND COALESCE(k.end_date, k.start_date, k.created_at::DATE) >= v_month;

    IF COALESCE(v_total, 0) <= 0 THEN
        RETURN NULL;
    END IF;

    SELECT LEAST(
        100,
        ROUND(COALESCE(SUM(COALESCE(k.weight, 0)), 0), 2)
    )
    INTO v_weight
    FROM public.kpis k
    WHERE k.user_id = p_user_id
      AND k.completion_status = 'completed'
      AND COALESCE(k.start_date, k.created_at::DATE) <= v_month_end
      AND COALESCE(k.end_date, k.start_date, k.created_at::DATE) >= v_month;

    RETURN COALESCE(v_weight, 0);
END;
$$;

-- Weightage never exceeds 100 — restore closed gift ceilings for dinner / surprise.
UPDATE public.kpi_award_config
SET dinner_max_pct = 100,
    gift_max_pct = 100,
    updated_at = timezone('utc'::text, now())
WHERE dinner_max_pct >= 9999
   OR gift_max_pct >= 9999;

ALTER TABLE public.kpi_award_config
    ALTER COLUMN dinner_max_pct SET DEFAULT 100,
    ALTER COLUMN gift_max_pct SET DEFAULT 100;

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
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 100);
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
            'Need ' || v_cfg.movie_months::TEXT || ' months in a row at weightage ' || v_movie_band || '%'
            || '. This month: ' || round(v_latest, 1)::TEXT || '%.'
        WHEN v_movie = 0 THEN
            'Need ' || v_cfg.movie_months::TEXT || ' months in a row at weightage ' || v_movie_band || '%.'
        ELSE v_movie::TEXT || ' of ' || v_cfg.movie_months::TEXT || ' months at weightage ' || v_movie_band || '%.'
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
        WHEN v_dinner = 1 THEN 'You met this month''s weightage target — waiting for approval.'
        WHEN v_latest IS NULL THEN 'Reach weightage of ' || v_dinner_band || '% in any one month.'
        WHEN v_latest < v_cfg.dinner_min_pct THEN
            'This month''s weightage is ' || round(v_latest, 1)::TEXT
            || '%. Reach ' || v_dinner_band || '% to qualify.'
        WHEN v_latest > v_cfg.dinner_max_pct THEN
            'This month''s weightage is ' || round(v_latest, 1)::TEXT
            || '%. This gift is for weightage ' || v_dinner_band || '%.'
        ELSE
            'This month''s weightage is ' || round(v_latest, 1)::TEXT
            || '% — you meet the ' || v_dinner_band || '% target.'
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
            'Need ' || v_cfg.gift_months::TEXT || ' months in a row at weightage ' || v_gift_band || '%'
            || '. This month: ' || round(v_latest, 1)::TEXT || '%.'
        WHEN v_gift = 0 THEN
            'Need ' || v_cfg.gift_months::TEXT || ' months in a row at weightage ' || v_gift_band || '%.'
        ELSE v_gift::TEXT || ' of ' || v_cfg.gift_months::TEXT || ' months at weightage ' || v_gift_band || '%.'
    END;
    RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kpi_award_month_score(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
