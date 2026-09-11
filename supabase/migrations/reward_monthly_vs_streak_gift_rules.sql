-- Allow monthly gift + streak gift (movie/surprise) in the same month.
-- Still only one monthly gift (dinner OR catalog) per month.
-- Available weightage = earned − ledger − reserved (pending/approved costs).

CREATE OR REPLACE FUNCTION public.get_weightage_reserved(p_user_id UUID, p_month DATE DEFAULT NULL)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc(
        'month',
        COALESCE(p_month, (timezone('Asia/Karachi', now()))::DATE)
    )::DATE;
    v_cat NUMERIC := 0;
    v_kpi NUMERIC := 0;
BEGIN
    SELECT COALESCE(SUM(COALESCE(r.weightage_cost, c.weightage_required, 0)), 0)
    INTO v_cat
    FROM public.reward_redemptions r
    LEFT JOIN public.rewards_catalog c ON c.id = r.reward_id
    WHERE r.employee_id = p_user_id
      AND date_trunc('month', (timezone('Asia/Karachi', r.redeemed_at))::DATE) = v_month
      AND r.status IN ('pending', 'approved');

    SELECT COALESCE(SUM(COALESCE(q.weightage_cost, 0)), 0)
    INTO v_kpi
    FROM public.kpi_award_qualifications q
    WHERE q.employee_id = p_user_id
      AND q.period_end = v_month
      AND q.status IN ('pending', 'approved', 'pending_fulfillment');

    RETURN ROUND(COALESCE(v_cat, 0) + COALESCE(v_kpi, 0), 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_available_weightage(p_user_id UUID, p_month DATE DEFAULT NULL)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc(
        'month',
        COALESCE(p_month, (timezone('Asia/Karachi', now()))::DATE)
    )::DATE;
    v_earned NUMERIC;
BEGIN
    v_earned := public.kpi_award_month_score(p_user_id, v_month);
    IF v_earned IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN GREATEST(
        0,
        ROUND(
            v_earned
            - public.get_weightage_deducted(p_user_id, v_month)
            - public.get_weightage_reserved(p_user_id, v_month),
            2
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_month_weightage_balance(p_user_id UUID DEFAULT NULL)
RETURNS TABLE (
    month DATE,
    earned NUMERIC,
    deducted NUMERIC,
    available NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := COALESCE(p_user_id, auth.uid());
    v_month DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
    v_earned NUMERIC;
    v_deducted NUMERIC;
    v_reserved NUMERIC;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Not allowed';
    END IF;

    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_deducted := public.get_weightage_deducted(v_uid, v_month);
    v_reserved := public.get_weightage_reserved(v_uid, v_month);
    month := v_month;
    earned := v_earned;
    deducted := ROUND(COALESCE(v_deducted, 0) + COALESCE(v_reserved, 0), 2);
    available := CASE
        WHEN v_earned IS NULL THEN NULL
        ELSE GREATEST(0, ROUND(v_earned - COALESCE(v_deducted, 0) - COALESCE(v_reserved, 0), 2))
    END;
    RETURN NEXT;
END;
$$;

-- Monthly gifts: catalog OR dinner (once per month).
CREATE OR REPLACE FUNCTION public.has_month_monthly_gift_claim(p_user_id UUID, p_month DATE DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc(
        'month',
        COALESCE(p_month, (timezone('Asia/Karachi', now()))::DATE)
    )::DATE;
    v_hit BOOLEAN := false;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.reward_redemptions r
        WHERE r.employee_id = p_user_id
          AND date_trunc('month', (timezone('Asia/Karachi', r.redeemed_at))::DATE) = v_month
          AND r.status IS DISTINCT FROM 'dismissed'
    ) INTO v_hit;
    IF v_hit THEN RETURN true; END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.kpi_award_qualifications q
        WHERE q.employee_id = p_user_id
          AND q.period_end = v_month
          AND q.rule_key = 'dinner_voucher'
          AND q.status IS DISTINCT FROM 'dismissed'
    ) INTO v_hit;
    RETURN COALESCE(v_hit, false);
END;
$$;

-- Streak gifts: movie OR surprise (one streak redeem per month; can sit beside a monthly gift).
CREATE OR REPLACE FUNCTION public.has_month_streak_gift_claim(p_user_id UUID, p_month DATE DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc(
        'month',
        COALESCE(p_month, (timezone('Asia/Karachi', now()))::DATE)
    )::DATE;
    v_hit BOOLEAN := false;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.kpi_award_qualifications q
        WHERE q.employee_id = p_user_id
          AND q.period_end = v_month
          AND q.rule_key IN ('movie_tickets', 'surprise_gift')
          AND q.status IS DISTINCT FROM 'dismissed'
    ) INTO v_hit;
    RETURN COALESCE(v_hit, false);
END;
$$;

-- Keep old name as "any gift" for compatibility (monthly OR streak).
CREATE OR REPLACE FUNCTION public.has_month_gift_claim(p_user_id UUID, p_month DATE DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN public.has_month_monthly_gift_claim(p_user_id, p_month)
        OR public.has_month_streak_gift_claim(p_user_id, p_month);
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_catalog_reward(p_reward_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_item public.rewards_catalog%ROWTYPE;
    v_month DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
    v_earned NUMERIC;
    v_available NUMERIC;
    v_cost NUMERIC;
    v_existing UUID;
    v_id UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_reward_id IS NULL THEN RAISE EXCEPTION 'Reward is required'; END IF;

    SELECT * INTO v_me FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
    IF v_me.role::text NOT IN ('employee', 'manager') THEN
        RAISE EXCEPTION 'Only employees and managers can redeem catalog rewards';
    END IF;

    SELECT * INTO v_item FROM public.rewards_catalog WHERE id = p_reward_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reward not found'; END IF;
    IF v_item.active IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'This reward is not available';
    END IF;

    SELECT r.id INTO v_existing
    FROM public.reward_redemptions r
    WHERE r.employee_id = v_uid
      AND r.reward_id = p_reward_id
      AND r.status IN ('pending', 'approved')
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    IF public.has_month_monthly_gift_claim(v_uid, v_month) THEN
        RAISE EXCEPTION 'You can redeem only one monthly gift per month (catalog or dinner)';
    END IF;

    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := public.get_available_weightage(v_uid, v_month);
    v_cost := COALESCE(v_item.weightage_required, 0);

    IF v_available IS NULL THEN
        RAISE EXCEPTION 'No KPI weightage for this month yet';
    END IF;
    IF v_available < v_cost THEN
        RAISE EXCEPTION 'Need at least % available weightage this month (you have % available, % earned)',
            trim(to_char(v_cost, 'FM999990.#######')) || '%',
            trim(to_char(v_available, 'FM999990.#######')) || '%',
            trim(to_char(COALESCE(v_earned, 0), 'FM999990.#######')) || '%';
    END IF;

    INSERT INTO public.reward_redemptions (
        employee_id, reward_id, points_used, weightage_at_claim, weightage_cost, status
    )
    VALUES (v_uid, p_reward_id, 0, v_available, v_cost, 'pending')
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

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
            RAISE EXCEPTION 'Keep earned weightage in the movie-ticket band for % months in a row first', v_cfg.movie_months;
        END IF;
        -- Streak gifts do not spend monthly weightage (can sit beside one monthly gift).
        v_name := v_cfg.movie_reward_name;
        v_months := v_streak;
        v_cost := 0;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.movie_min_pct::TEXT || '–' || v_cfg.movie_max_pct::TEXT
            || '% weightage for ' || v_cfg.movie_months::TEXT || ' consecutive months.';
    ELSE
        IF public.has_month_streak_gift_claim(v_uid, v_month) THEN
            RAISE EXCEPTION 'You already redeemed a 3-month or 6-month gift this month';
        END IF;
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift'
        );
        IF v_streak < v_cfg.gift_months THEN
            RAISE EXCEPTION 'Keep earned weightage in the surprise-gift band for % months in a row first', v_cfg.gift_months;
        END IF;
        v_name := v_cfg.gift_reward_name;
        v_months := v_streak;
        v_cost := 0;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.gift_min_pct::TEXT || '–' || v_gift_max::TEXT
            || '% weightage for ' || v_cfg.gift_months::TEXT || ' consecutive months.';
    END IF;

    INSERT INTO public.kpi_award_qualifications (
        company_id, employee_id, rule_key, reward_name, detail, period_end,
        months_met, latest_score, weightage_cost, status
    )
    VALUES (
        v_me.company_id, v_uid, v_key, v_name, v_detail, v_month,
        v_months, v_available, v_cost, 'pending'
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
    qualified := v_movie >= v_cfg.movie_months
        AND NOT v_streak_claimed;
    hint := CASE
        WHEN v_streak_claimed THEN 'You already redeemed a 3-month or 6-month gift this month.'
        WHEN v_movie >= v_cfg.movie_months THEN
            'Streak met — redeem anytime this month (allowed with one monthly gift; does not spend weightage).'
        WHEN v_movie = 0 THEN
            'Need ' || v_cfg.movie_months::TEXT || ' months in a row at earned weightage ' || v_movie_band || '%.'
        ELSE v_movie::TEXT || ' of ' || v_cfg.movie_months::TEXT || ' months at earned weightage ' || v_movie_band || '%.'
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
            'Qualified — redeeming dinner uses ' || trim(to_char(v_cfg.dinner_min_pct, 'FM999990.#######')) || '% available weightage.'
        ELSE 'Need available weightage ' || v_dinner_band || '% this month (earned '
            || trim(to_char(COALESCE(v_earned, 0), 'FM999990.#######')) || '%).'
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
    qualified := v_gift >= v_cfg.gift_months
        AND NOT v_streak_claimed;
    hint := CASE
        WHEN v_streak_claimed THEN 'You already redeemed a 3-month or 6-month gift this month.'
        WHEN v_gift >= v_cfg.gift_months THEN
            'Streak met — redeem anytime this month (allowed with one monthly gift; does not spend weightage).'
        WHEN v_gift = 0 THEN
            'Need ' || v_cfg.gift_months::TEXT || ' months in a row at earned weightage ' || v_gift_band || '%.'
        ELSE v_gift::TEXT || ' of ' || v_cfg.gift_months::TEXT || ' months at earned weightage ' || v_gift_band || '%.'
    END;
    RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_weightage_reserved(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_available_weightage(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_month_weightage_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_month_monthly_gift_claim(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_month_streak_gift_claim(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_month_gift_claim(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_catalog_reward(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
