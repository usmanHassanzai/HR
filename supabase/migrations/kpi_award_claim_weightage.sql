-- Ensure company gifts use monthly weightage (0–100%), not score points.
-- Employees can claim (redeem) a gift when they meet the rule.

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

-- Monthly weightage achieved = sum of completed KPI weights overlapping the month (capped at 100).
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

UPDATE public.kpi_award_config
SET dinner_max_pct = 100,
    gift_max_pct = 100,
    updated_at = timezone('utc'::text, now())
WHERE dinner_max_pct >= 9999
   OR gift_max_pct >= 9999
   OR dinner_max_pct IS NULL
   OR gift_max_pct IS NULL;

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
        WHEN v_movie >= v_cfg.movie_months THEN 'You met the target — tap Redeem to request this gift.'
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
        WHEN v_dinner = 1 THEN 'You met this month''s weightage target — tap Redeem to request this gift.'
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
        WHEN v_gift >= v_cfg.gift_months THEN 'You met the target — tap Redeem to request this gift.'
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

-- Employee redeems / claims a gift once they meet the rule for the current month.
CREATE OR REPLACE FUNCTION public.claim_my_kpi_award(p_rule_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_cfg public.kpi_award_config;
    v_month DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
    v_key TEXT := lower(trim(COALESCE(p_rule_key, '')));
    v_weight NUMERIC;
    v_streak INTEGER;
    v_gift_max NUMERIC;
    v_name TEXT;
    v_detail TEXT;
    v_months INTEGER;
    v_id UUID;
    v_existing UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF v_key NOT IN ('movie_tickets', 'dinner_voucher', 'surprise_gift') THEN
        RAISE EXCEPTION 'Unknown reward';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = v_uid;
    IF NOT FOUND OR v_me.company_id IS NULL THEN
        RAISE EXCEPTION 'Account not linked to a company';
    END IF;
    IF v_me.role::text NOT IN ('employee', 'manager') THEN
        RAISE EXCEPTION 'Only employees and managers can redeem company gifts';
    END IF;

    v_cfg := public.ensure_kpi_award_config(v_me.company_id);
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 100);
    v_weight := public.kpi_award_month_score(v_uid, v_month);

    IF v_key = 'dinner_voucher' THEN
        IF NOT public.kpi_award_in_band(v_weight, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
            RAISE EXCEPTION 'You have not reached the dinner weightage target this month';
        END IF;
        v_name := v_cfg.dinner_reward_name;
        v_months := 1;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — weightage ' || round(COALESCE(v_weight, 0), 2)::TEXT || '% in '
            || to_char(v_month, 'Mon YYYY') || '.';
    ELSIF v_key = 'movie_tickets' THEN
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets'
        );
        IF v_streak < v_cfg.movie_months THEN
            RAISE EXCEPTION 'Keep weightage in the movie-ticket band for % months in a row first', v_cfg.movie_months;
        END IF;
        v_name := v_cfg.movie_reward_name;
        v_months := v_streak;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.movie_min_pct::TEXT || '–' || v_cfg.movie_max_pct::TEXT
            || '% weightage for ' || v_cfg.movie_months::TEXT || ' consecutive months.';
    ELSE
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift'
        );
        IF v_streak < v_cfg.gift_months THEN
            RAISE EXCEPTION 'Keep weightage in the surprise-gift band for % months in a row first', v_cfg.gift_months;
        END IF;
        v_name := v_cfg.gift_reward_name;
        v_months := v_streak;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.gift_min_pct::TEXT || '–' || v_gift_max::TEXT
            || '% weightage for ' || v_cfg.gift_months::TEXT || ' consecutive months.';
    END IF;

    SELECT q.id INTO v_existing
    FROM public.kpi_award_qualifications q
    WHERE q.employee_id = v_uid
      AND q.rule_key = v_key
      AND q.period_end = v_month
      AND q.status IS DISTINCT FROM 'dismissed'
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    INSERT INTO public.kpi_award_qualifications (
        company_id, employee_id, rule_key, reward_name, detail, period_end, months_met, latest_score, status
    )
    VALUES (
        v_me.company_id, v_uid, v_key, v_name, v_detail, v_month, v_months, v_weight, 'pending'
    )
    ON CONFLICT (employee_id, rule_key, period_end) DO UPDATE
    SET detail = EXCLUDED.detail,
        months_met = EXCLUDED.months_met,
        latest_score = EXCLUDED.latest_score,
        reward_name = EXCLUDED.reward_name,
        status = CASE
            WHEN public.kpi_award_qualifications.status = 'dismissed' THEN 'pending'
            ELSE public.kpi_award_qualifications.status
        END
    RETURNING id INTO v_id;

    PERFORM public.create_system_notification(
        v_uid,
        'Gift request submitted',
        'Your request for ' || v_name || ' was sent for approval.',
        'info'
    );
    PERFORM public.notify_company_award_staff(
        v_me.company_id,
        'Gift request: ' || COALESCE(v_me.full_name, 'Employee'),
        v_detail
    );

    RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kpi_award_month_score(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
