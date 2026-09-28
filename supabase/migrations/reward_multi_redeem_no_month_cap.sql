-- Allow multiple gift/catalog redemptions in the same month when remaining
-- weightage (Current or Banked) still covers each gift cost.
-- Removes the hard "one monthly gift per month" gate.

-- Allow another dinner claim in the same month after the previous one is finished.
DO $$
DECLARE
  v_con TEXT;
BEGIN
  SELECT c.conname INTO v_con
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'kpi_award_qualifications'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) ILIKE '%employee_id%rule_key%period_end%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.kpi_award_qualifications DROP CONSTRAINT %I', v_con);
  END IF;
END
$$;

DROP INDEX IF EXISTS public.kpi_award_open_claim_uniq;
CREATE UNIQUE INDEX kpi_award_open_claim_uniq
  ON public.kpi_award_qualifications (employee_id, rule_key, period_end)
  WHERE status IN ('pending', 'approved', 'pending_fulfillment');

CREATE OR REPLACE FUNCTION public.redeem_catalog_reward(
    p_reward_id UUID,
    p_use_banked BOOLEAN DEFAULT false
)
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
    v_bank NUMERIC;
    v_need NUMERIC;
    v_cost NUMERIC;
    v_existing UUID;
    v_id UUID;
    v_use_bank BOOLEAN := COALESCE(p_use_banked, false);
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_reward_id IS NULL THEN RAISE EXCEPTION 'Reward is required'; END IF;

    SELECT * INTO v_me FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
    IF v_me.role::text NOT IN ('employee', 'manager') THEN
        RAISE EXCEPTION 'Only employees and managers can redeem catalog rewards';
    END IF;
    IF v_me.company_id IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

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

    -- No per-month gift count limit — only remaining weightage matters.

    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := public.get_available_weightage(v_uid, v_month);
    v_bank := public.get_banked_weightage(v_uid);
    v_need := COALESCE(v_item.weightage_required, 0);
    v_cost := v_need;

    IF v_use_bank THEN
        IF v_bank < v_need THEN
            RAISE EXCEPTION 'Need at least % banked weightage (you have % banked)',
                trim(to_char(v_need, 'FM999990.#######')) || '%',
                trim(to_char(v_bank, 'FM999990.#######')) || '%';
        END IF;
    ELSE
        IF v_available IS NULL THEN
            RAISE EXCEPTION 'No KPI weightage for this month yet';
        END IF;
        IF v_available < v_need THEN
            RAISE EXCEPTION 'Need at least % available weightage this month (you have % available, % earned). Or redeem with banked if you have enough.',
                trim(to_char(v_need, 'FM999990.#######')) || '%',
                trim(to_char(v_available, 'FM999990.#######')) || '%',
                trim(to_char(COALESCE(v_earned, 0), 'FM999990.#######')) || '%';
        END IF;
    END IF;

    INSERT INTO public.reward_redemptions (
        employee_id, reward_id, points_used, weightage_at_claim, weightage_cost, status
    )
    VALUES (
        v_uid,
        p_reward_id,
        0,
        CASE WHEN v_use_bank THEN v_bank ELSE v_available END,
        v_cost,
        'pending'
    )
    RETURNING id INTO v_id;

    IF v_use_bank THEN
        PERFORM public.bank_spend(
            v_uid,
            v_me.company_id,
            v_cost,
            'catalog',
            v_id,
            'Redeemed catalog from bank: ' || COALESCE(v_item.name, 'reward')
        );
    ELSE
        PERFORM public.pay_monthly_gift_weightage(
            v_uid,
            v_me.company_id,
            v_month,
            v_available,
            v_cost,
            'catalog',
            v_id,
            'Redeemed catalog: ' || COALESCE(v_item.name, 'reward')
        );
    END IF;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_my_kpi_award(
    p_rule_key TEXT,
    p_use_banked BOOLEAN DEFAULT false
)
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
    v_bank NUMERIC;
    v_streak INTEGER;
    v_gift_max NUMERIC;
    v_name TEXT;
    v_detail TEXT;
    v_months INTEGER;
    v_cost NUMERIC;
    v_id UUID;
    v_existing UUID;
    v_leftover NUMERIC := 0;
    v_use_bank BOOLEAN := COALESCE(p_use_banked, false);
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
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 95);
    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := public.get_available_weightage(v_uid, v_month);
    v_bank := public.get_banked_weightage(v_uid);

    -- Only block a duplicate open request; finished claims do not lock the month.
    SELECT q.id INTO v_existing
    FROM public.kpi_award_qualifications q
    WHERE q.employee_id = v_uid
      AND q.rule_key = v_key
      AND q.period_end = v_month
      AND q.status IN ('pending', 'approved', 'pending_fulfillment')
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    IF v_key = 'dinner_voucher' THEN
        -- No one-monthly-gift lock — weightage balance is the only gate.
        v_cost := v_cfg.dinner_min_pct;
        v_name := v_cfg.dinner_reward_name;
        v_months := 1;

        IF v_use_bank THEN
            IF v_bank < v_cost THEN
                RAISE EXCEPTION 'Need at least % banked weightage (you have % banked)',
                    trim(to_char(v_cost, 'FM999990.#######')) || '%',
                    trim(to_char(v_bank, 'FM999990.#######')) || '%';
            END IF;
            v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
                || ' — paid ' || round(v_cost, 2)::TEXT || '% from banked weightage.';
        ELSE
            IF NOT public.kpi_award_in_band(v_available, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
                RAISE EXCEPTION 'You need %–% available weightage this month (you have % available). Or redeem with banked if you have enough.',
                    trim(to_char(v_cfg.dinner_min_pct, 'FM999990.#######')),
                    trim(to_char(v_cfg.dinner_max_pct, 'FM999990.#######')),
                    trim(to_char(COALESCE(v_available, 0), 'FM999990.#######')) || '%';
            END IF;
            v_leftover := GREATEST(0, ROUND(COALESCE(v_available, 0) - v_cost, 2));
            v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
                || ' — used ' || round(COALESCE(v_cost, 0), 2)::TEXT || '% weightage in '
                || to_char(v_month, 'Mon YYYY')
                || CASE
                    WHEN v_leftover > 0 THEN
                        '; ' || round(v_leftover, 2)::TEXT || '% moved to banked.'
                    ELSE '.'
                END;
        END IF;
    ELSIF v_key = 'movie_tickets' THEN
        IF v_use_bank THEN
            RAISE EXCEPTION 'Streak gifts do not use banked weightage';
        END IF;
        IF public.has_month_streak_gift_claim(v_uid, v_month) THEN
            RAISE EXCEPTION 'You already redeemed a 3-month or 6-month gift this month';
        END IF;
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets'
        );
        IF v_streak < v_cfg.movie_months THEN
            RAISE EXCEPTION 'Keep earned weightage at %–% for % months in a row first',
                trim(to_char(v_cfg.movie_min_pct, 'FM999990.#######')),
                trim(to_char(v_cfg.movie_max_pct, 'FM999990.#######')),
                v_cfg.movie_months;
        END IF;
        v_name := v_cfg.movie_reward_name;
        v_months := v_streak;
        v_cost := 0;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.movie_min_pct::TEXT || '–' || v_cfg.movie_max_pct::TEXT
            || '% weightage for ' || v_cfg.movie_months::TEXT || ' consecutive months.';
    ELSE
        IF v_use_bank THEN
            RAISE EXCEPTION 'Streak gifts do not use banked weightage';
        END IF;
        IF public.has_month_streak_gift_claim(v_uid, v_month) THEN
            RAISE EXCEPTION 'You already redeemed a 3-month or 6-month gift this month';
        END IF;
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift'
        );
        IF v_streak < v_cfg.gift_months THEN
            RAISE EXCEPTION 'Keep earned weightage at %–% for % months in a row first',
                trim(to_char(v_cfg.gift_min_pct, 'FM999990.#######')),
                trim(to_char(v_gift_max, 'FM999990.#######')),
                v_cfg.gift_months;
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
        v_months,
        CASE
            WHEN v_key = 'dinner_voucher' AND v_use_bank THEN v_bank
            ELSE COALESCE(v_available, v_earned)
        END,
        v_cost,
        'pending'
    )
    RETURNING id INTO v_id;

    IF v_key = 'dinner_voucher' AND COALESCE(v_cost, 0) > 0 THEN
        IF v_use_bank THEN
            PERFORM public.bank_spend(
                v_uid,
                v_me.company_id,
                v_cost,
                'kpi_award',
                v_id,
                'Redeemed from bank: ' || v_name
            );
        ELSE
            PERFORM public.pay_monthly_gift_weightage(
                v_uid,
                v_me.company_id,
                v_month,
                COALESCE(v_available, 0),
                v_cost,
                'kpi_award',
                v_id,
                'Redeemed: ' || v_name
            );
        END IF;
    END IF;

    PERFORM public.create_system_notification(
        v_uid,
        'Gift request submitted',
        'Your request for ' || v_name || ' was sent for approval.'
            || CASE
                WHEN v_key = 'dinner_voucher' AND v_use_bank THEN
                    ' Paid from banked weightage.'
                WHEN v_key = 'dinner_voucher' AND COALESCE(v_leftover, 0) > 0 THEN
                    ' ' || trim(to_char(v_leftover, 'FM999990.#######'))
                    || '% leftover was moved to your banked weightage.'
                WHEN v_key = 'dinner_voucher' THEN
                    ' Gift cost deducted from this month.'
                ELSE ''
            END,
        'info'
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
    v_bank NUMERIC;
    v_movie INT;
    v_dinner INT;
    v_gift INT;
    v_gift_max NUMERIC;
    v_dinner_band TEXT;
    v_gift_band TEXT;
    v_movie_band TEXT;
    v_streak_claimed BOOLEAN;
    v_dinner_open BOOLEAN;
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
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 95);
    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := public.get_available_weightage(v_uid, v_month);
    v_bank := public.get_banked_weightage(v_uid);
    v_streak_claimed := public.has_month_streak_gift_claim(v_uid, v_month);
    SELECT EXISTS (
        SELECT 1 FROM public.kpi_award_qualifications q
        WHERE q.employee_id = v_uid
          AND q.rule_key = 'dinner_voucher'
          AND q.period_end = v_month
          AND q.status IN ('pending', 'approved', 'pending_fulfillment')
    ) INTO v_dinner_open;

    v_movie_band := public.kpi_award_band_label(v_cfg.movie_min_pct, v_cfg.movie_max_pct);
    v_dinner_band := public.kpi_award_band_label(v_cfg.dinner_min_pct, v_cfg.dinner_max_pct);
    v_gift_band := public.kpi_award_band_label(v_cfg.gift_min_pct, v_gift_max);

    v_movie := public.kpi_award_consecutive_months(v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets');
    v_dinner := CASE
        WHEN public.kpi_award_in_band(v_available, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN 1
        WHEN COALESCE(v_bank, 0) >= v_cfg.dinner_min_pct THEN 1
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
            'Streak complete — you can redeem this gift.'
        WHEN v_movie = 0 THEN
            'Need ' || v_cfg.movie_months::TEXT || ' months in a row at earned weightage ' || v_movie_band || '%.'
        ELSE v_movie::TEXT || ' of ' || v_cfg.movie_months::TEXT || ' months in a row at ' || v_movie_band || '%.'
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
    qualified := v_dinner >= 1 AND NOT v_dinner_open;
    hint := CASE
        WHEN v_dinner_open THEN 'You already have an open dinner request waiting for approval.'
        WHEN public.kpi_award_in_band(v_available, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
            'Qualified — uses '
            || trim(to_char(v_cfg.dinner_min_pct, 'FM999990.#######'))
            || '% from current; leftover moves to banked. Redeem again anytime remaining weightage covers the cost.'
        WHEN COALESCE(v_bank, 0) >= v_cfg.dinner_min_pct THEN
            'Current is short — redeem with banked ('
            || trim(to_char(v_bank, 'FM999990.#######')) || '%).'
        ELSE 'Need available weightage ' || v_dinner_band || '% this month (earned '
            || trim(to_char(COALESCE(v_earned, 0), 'FM999990.#######')) || '%) or enough banked.'
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
            'Streak complete — you can redeem this gift.'
        WHEN v_gift = 0 THEN
            'Need ' || v_cfg.gift_months::TEXT || ' months in a row at earned weightage ' || v_gift_band || '%.'
        ELSE v_gift::TEXT || ' of ' || v_cfg.gift_months::TEXT || ' months in a row at ' || v_gift_band || '%.'
    END;
    RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_catalog_reward(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
