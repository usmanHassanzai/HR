-- Current month available + banked are summed for gift eligibility and payment.
-- Example: 60% current + 30% banked = 90% → can redeem gifts that need ≤90% / sit in that band.
-- Payment always draws current first, then banked (pay_monthly_gift_weightage).

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
    v_available NUMERIC;
    v_bank NUMERIC;
    v_total NUMERIC;
    v_need NUMERIC;
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

    PERFORM public.rollover_unused_weightage_to_bank(v_uid);

    v_available := COALESCE(public.get_available_weightage(v_uid, v_month), 0);
    v_bank := COALESCE(public.get_banked_weightage(v_uid), 0);
    v_total := ROUND(v_available + v_bank, 2);
    v_need := COALESCE(v_item.weightage_required, 0);
    v_cost := v_need;

    IF v_total < v_need THEN
        RAISE EXCEPTION 'Need at least % total weightage (current % + banked % = %). Banked never expires.',
            trim(to_char(v_need, 'FM999990.#######')) || '%',
            trim(to_char(v_available, 'FM999990.#######')) || '%',
            trim(to_char(v_bank, 'FM999990.#######')) || '%',
            trim(to_char(v_total, 'FM999990.#######')) || '%';
    END IF;

    INSERT INTO public.reward_redemptions (
        employee_id, reward_id, points_used, weightage_at_claim, weightage_cost, status
    )
    VALUES (
        v_uid,
        p_reward_id,
        0,
        v_total,
        v_cost,
        'pending'
    )
    RETURNING id INTO v_id;

    -- Spend current first, then banked; leftover current moves to bank.
    PERFORM public.pay_monthly_gift_weightage(
        v_uid,
        v_me.company_id,
        v_month,
        v_available,
        v_cost,
        'catalog',
        v_id,
        'Redeemed catalog (current + banked): ' || COALESCE(v_item.name, 'reward')
    );

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_my_kpi_award(p_rule_key text, p_use_banked boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_cfg public.kpi_award_config;
    v_month DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
    v_key TEXT := lower(trim(COALESCE(p_rule_key, '')));
    v_earned NUMERIC;
    v_available NUMERIC;
    v_bank NUMERIC;
    v_total NUMERIC;
    v_streak INTEGER;
    v_gift_max NUMERIC;
    v_name TEXT;
    v_detail TEXT;
    v_months INTEGER;
    v_cost NUMERIC;
    v_id UUID;
    v_existing UUID;
    v_leftover NUMERIC := 0;
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

    PERFORM public.rollover_unused_weightage_to_bank(v_uid);

    v_cfg := public.ensure_kpi_award_config(v_me.company_id);
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 95);
    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := COALESCE(public.get_available_weightage(v_uid, v_month), 0);
    v_bank := COALESCE(public.get_banked_weightage(v_uid), 0);
    v_total := ROUND(v_available + v_bank, 2);

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
        v_cost := v_cfg.dinner_min_pct;
        v_name := v_cfg.dinner_reward_name;
        v_months := 1;

        -- Qualify on combined current + banked (e.g. 60% + 30% = 90%).
        IF NOT public.kpi_award_in_band(v_total, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
            RAISE EXCEPTION 'You need %–% total weightage (current % + banked % = %). Banked never expires.',
                trim(to_char(v_cfg.dinner_min_pct, 'FM999990.#######')),
                trim(to_char(v_cfg.dinner_max_pct, 'FM999990.#######')),
                trim(to_char(v_available, 'FM999990.#######')) || '%',
                trim(to_char(v_bank, 'FM999990.#######')) || '%',
                trim(to_char(v_total, 'FM999990.#######')) || '%';
        END IF;
        IF v_total < v_cost THEN
            RAISE EXCEPTION 'Need at least % total weightage to pay this gift (you have %)',
                trim(to_char(v_cost, 'FM999990.#######')) || '%',
                trim(to_char(v_total, 'FM999990.#######')) || '%';
        END IF;

        v_leftover := GREATEST(0, ROUND(v_total - v_cost, 2));
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — paid ' || round(v_cost, 2)::TEXT || '% from current '
            || trim(to_char(v_available, 'FM999990.#######')) || '% + banked '
            || trim(to_char(v_bank, 'FM999990.#######')) || '%'
            || CASE
                WHEN v_leftover > 0 THEN
                    '; ' || round(v_leftover, 2)::TEXT || '% remains (never expires).'
                ELSE '.'
            END;
    ELSIF v_key = 'movie_tickets' THEN
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
            WHEN v_key = 'dinner_voucher' THEN v_total
            ELSE COALESCE(v_available, v_earned)
        END,
        v_cost,
        'pending'
    )
    RETURNING id INTO v_id;

    IF v_key = 'dinner_voucher' AND COALESCE(v_cost, 0) > 0 THEN
        PERFORM public.pay_monthly_gift_weightage(
            v_uid,
            v_me.company_id,
            v_month,
            v_available,
            v_cost,
            'kpi_award',
            v_id,
            'Redeemed (current + banked): ' || v_name
        );
    END IF;

    PERFORM public.create_system_notification(
        v_uid,
        'Gift request submitted',
        'Your request for ' || v_name || ' was sent for approval.'
            || CASE
                WHEN v_key = 'dinner_voucher' AND COALESCE(v_leftover, 0) > 0 THEN
                    ' ' || trim(to_char(v_leftover, 'FM999990.#######'))
                    || '% weightage remains and never expires.'
                WHEN v_key = 'dinner_voucher' THEN
                    ' Gift cost deducted from current + banked weightage.'
                ELSE ''
            END,
        'info',
        jsonb_build_object('kind', 'award', 'awardId', v_id, 'userId', v_uid, 'rewardsTab', 'awards')
    );

    PERFORM public.notify_company_award_staff(
        v_me.company_id,
        'Gift request: ' || COALESCE(v_me.full_name, 'Employee'),
        COALESCE(v_detail, 'A gift request was submitted.'),
        jsonb_build_object('kind', 'award', 'awardId', v_id, 'userId', v_uid, 'search', COALESCE(v_me.full_name, ''), 'rewardsTab', 'awards')
    );

    RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.redeem_catalog_reward(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
