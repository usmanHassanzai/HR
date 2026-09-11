-- Qualifying months for movie/surprise are NOT wiped by a low month.
-- Count months that meet the minimum (open ceiling = higher % still counts).
-- Redeem streak gifts anytime after enough qualifying months since last claim.

CREATE OR REPLACE FUNCTION public.kpi_award_consecutive_months(
    p_user_id UUID,
    p_min NUMERIC,
    p_max NUMERIC,
    p_from DATE DEFAULT NULL,
    p_rule_key TEXT DEFAULT NULL
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
    v_last DATE;
BEGIN
    IF p_rule_key IS NOT NULL THEN
        SELECT MAX(period_end) INTO v_last
        FROM public.kpi_award_qualifications
        WHERE employee_id = p_user_id
          AND rule_key = p_rule_key
          AND status IS DISTINCT FROM 'dismissed';
    END IF;

    -- Walk back up to 24 months. Months below the bar are skipped (not wasted /
    -- they do not reset progress). Only months at or above the min count.
    FOR v_i IN 1..24 LOOP
        IF v_last IS NOT NULL AND v_cursor <= v_last THEN
            EXIT;
        END IF;
        v_score := public.kpi_award_month_score(p_user_id, v_cursor);
        IF public.kpi_award_in_band(v_score, p_min, p_max) THEN
            v_count := v_count + 1;
        END IF;
        v_cursor := (v_cursor - INTERVAL '1 month')::DATE;
    END LOOP;
    RETURN v_count;
END;
$$;

-- Movie tickets: treat as minimum % (e.g. 85%+), not a closed 85–90 band.
UPDATE public.kpi_award_config
SET movie_max_pct = 100,
    updated_at = timezone('utc'::text, now())
WHERE movie_max_pct IS DISTINCT FROM 100
   OR movie_max_pct IS NULL;

ALTER TABLE public.kpi_award_config
    ALTER COLUMN movie_max_pct SET DEFAULT 100;

-- Progress hints: redeem anytime after enough qualifying months.
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
    v_earned NUMERIC;
    v_available NUMERIC;
    v_movie INT;
    v_dinner INT;
    v_gift INT;
    v_gift_max NUMERIC;
    v_dinner_band TEXT;
    v_gift_band TEXT;
    v_movie_band TEXT;
    v_monthly_claimed BOOLEAN;
    v_streak_claimed BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Not allowed';
    END IF;

    SELECT company_id INTO v_company FROM public.users WHERE id = v_uid;
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;
    v_cfg := public.ensure_kpi_award_config(v_company);
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 100);
    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := public.get_available_weightage(v_uid, v_month);
    v_monthly_claimed := public.has_month_monthly_gift_claim(v_uid, v_month);
    v_streak_claimed := public.has_month_streak_gift_claim(v_uid, v_month);

    v_movie_band := public.kpi_award_band_label(v_cfg.movie_min_pct, v_cfg.movie_max_pct);
    v_dinner_band := public.kpi_award_band_label(v_cfg.dinner_min_pct, v_cfg.dinner_max_pct);
    v_gift_band := public.kpi_award_band_label(v_cfg.gift_min_pct, v_gift_max);

    v_movie := public.kpi_award_consecutive_months(v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets');
    v_dinner := CASE
        WHEN public.kpi_award_in_band(v_available, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN 1
        ELSE 0
    END;
    v_gift := public.kpi_award_consecutive_months(v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift');

    rule_key := 'movie_tickets';
    reward_name := v_cfg.movie_reward_name;
    min_pct := v_cfg.movie_min_pct;
    max_pct := v_cfg.movie_max_pct;
    required_months := v_cfg.movie_months;
    current_months := LEAST(v_movie, v_cfg.movie_months);
    months_to_go := GREATEST(v_cfg.movie_months - v_movie, 0);
    latest_score := v_available;
    progress_pct := LEAST(100, ROUND((v_movie::NUMERIC / NULLIF(v_cfg.movie_months, 0)) * 100, 1));
    qualified := v_movie >= v_cfg.movie_months AND NOT v_streak_claimed;
    hint := CASE
        WHEN v_streak_claimed THEN 'You already redeemed a 3-month or 6-month gift this month.'
        WHEN v_movie >= v_cfg.movie_months THEN
            'Ready — redeem anytime (months at ' || v_movie_band || '%+ count; low months do not reset progress).'
        WHEN v_movie = 0 THEN
            'Need ' || v_cfg.movie_months::TEXT || ' months at earned weightage ' || v_movie_band
            || '%+ (low months are skipped, not lost).'
        ELSE v_movie::TEXT || ' of ' || v_cfg.movie_months::TEXT || ' months at ' || v_movie_band
            || '%+. Redeem anytime once complete.'
    END;
    RETURN NEXT;

    rule_key := 'dinner_voucher';
    reward_name := v_cfg.dinner_reward_name;
    min_pct := v_cfg.dinner_min_pct;
    max_pct := v_cfg.dinner_max_pct;
    required_months := 1;
    current_months := v_dinner;
    months_to_go := GREATEST(1 - v_dinner, 0);
    latest_score := v_available;
    progress_pct := CASE WHEN v_dinner >= 1 THEN 100 ELSE LEAST(100, ROUND((COALESCE(v_available, 0) / NULLIF(v_cfg.dinner_min_pct, 0)) * 100, 1)) END;
    qualified := v_dinner >= 1 AND NOT v_monthly_claimed;
    hint := CASE
        WHEN v_monthly_claimed THEN 'You already redeemed a monthly gift this month (catalog or dinner).'
        WHEN v_dinner >= 1 THEN
            'Qualified — redeem anytime this month (uses ' || trim(to_char(v_cfg.dinner_min_pct, 'FM999990.#######')) || '% available weightage).'
        ELSE 'Need available weightage ' || v_dinner_band || '% this month (earned '
            || trim(to_char(COALESCE(v_earned, 0), 'FM999990.#######')) || '%). Keep completing tasks — progress is not wasted.'
    END;
    RETURN NEXT;

    rule_key := 'surprise_gift';
    reward_name := v_cfg.gift_reward_name;
    min_pct := v_cfg.gift_min_pct;
    max_pct := v_gift_max;
    required_months := v_cfg.gift_months;
    current_months := LEAST(v_gift, v_cfg.gift_months);
    months_to_go := GREATEST(v_cfg.gift_months - v_gift, 0);
    latest_score := v_available;
    progress_pct := LEAST(100, ROUND((v_gift::NUMERIC / NULLIF(v_cfg.gift_months, 0)) * 100, 1));
    qualified := v_gift >= v_cfg.gift_months AND NOT v_streak_claimed;
    hint := CASE
        WHEN v_streak_claimed THEN 'You already redeemed a 3-month or 6-month gift this month.'
        WHEN v_gift >= v_cfg.gift_months THEN
            'Ready — redeem anytime (months at ' || v_gift_band || '%+ count; low months do not reset progress).'
        WHEN v_gift = 0 THEN
            'Need ' || v_cfg.gift_months::TEXT || ' months at earned weightage ' || v_gift_band
            || '%+ (low months are skipped, not lost).'
        ELSE v_gift::TEXT || ' of ' || v_cfg.gift_months::TEXT || ' months at ' || v_gift_band
            || '%+. Redeem anytime once complete.'
    END;
    RETURN NEXT;
END;
$$;

-- Claim movie/surprise: no requirement that this month is still in-band.
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
    v_earned NUMERIC;
    v_available NUMERIC;
    v_streak INTEGER;
    v_gift_max NUMERIC;
    v_name TEXT;
    v_detail TEXT;
    v_months INTEGER;
    v_cost NUMERIC;
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
    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := public.get_available_weightage(v_uid, v_month);

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

    IF v_key = 'dinner_voucher' THEN
        IF public.has_month_monthly_gift_claim(v_uid, v_month) THEN
            RAISE EXCEPTION 'You can redeem only one monthly gift per month (catalog or dinner)';
        END IF;
        IF NOT public.kpi_award_in_band(v_available, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
            RAISE EXCEPTION 'You need %–% available weightage this month (you have % available)',
                trim(to_char(v_cfg.dinner_min_pct, 'FM999990.#######')),
                trim(to_char(v_cfg.dinner_max_pct, 'FM999990.#######')),
                trim(to_char(COALESCE(v_available, 0), 'FM999990.#######')) || '%';
        END IF;
        v_name := v_cfg.dinner_reward_name;
        v_months := 1;
        v_cost := v_cfg.dinner_min_pct;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — available weightage ' || round(COALESCE(v_available, 0), 2)::TEXT || '% in '
            || to_char(v_month, 'Mon YYYY') || '.';
    ELSIF v_key = 'movie_tickets' THEN
        IF public.has_month_streak_gift_claim(v_uid, v_month) THEN
            RAISE EXCEPTION 'You already redeemed a 3-month or 6-month gift this month';
        END IF;
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets'
        );
        IF v_streak < v_cfg.movie_months THEN
            RAISE EXCEPTION 'Need % months at % weightage or higher first (low months do not reset progress)',
                v_cfg.movie_months,
                trim(to_char(v_cfg.movie_min_pct, 'FM999990.#######')) || '%';
        END IF;
        v_name := v_cfg.movie_reward_name;
        v_months := v_streak;
        v_cost := 0;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.movie_months::TEXT || ' months at '
            || trim(to_char(v_cfg.movie_min_pct, 'FM999990.#######')) || '%+ weightage.';
    ELSE
        IF public.has_month_streak_gift_claim(v_uid, v_month) THEN
            RAISE EXCEPTION 'You already redeemed a 3-month or 6-month gift this month';
        END IF;
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift'
        );
        IF v_streak < v_cfg.gift_months THEN
            RAISE EXCEPTION 'Need % months at % weightage or higher first (low months do not reset progress)',
                v_cfg.gift_months,
                trim(to_char(v_cfg.gift_min_pct, 'FM999990.#######')) || '%';
        END IF;
        v_name := v_cfg.gift_reward_name;
        v_months := v_streak;
        v_cost := 0;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.gift_months::TEXT || ' months at '
            || trim(to_char(v_cfg.gift_min_pct, 'FM999990.#######')) || '%+ weightage.';
    END IF;

    INSERT INTO public.kpi_award_qualifications (
        company_id, employee_id, rule_key, reward_name, detail, period_end,
        months_met, latest_score, weightage_cost, status
    )
    VALUES (
        v_me.company_id, v_uid, v_key, v_name, v_detail, v_month,
        v_months, COALESCE(v_available, v_earned), v_cost, 'pending'
    )
    ON CONFLICT (employee_id, rule_key, period_end) DO UPDATE
    SET detail = EXCLUDED.detail,
        months_met = EXCLUDED.months_met,
        latest_score = EXCLUDED.latest_score,
        reward_name = EXCLUDED.reward_name,
        weightage_cost = EXCLUDED.weightage_cost,
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

GRANT EXECUTE ON FUNCTION public.kpi_award_consecutive_months(UUID, NUMERIC, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
