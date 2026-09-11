-- Monthly gifts (dinner / catalog): spend ALL available weightage on redeem
-- so current available becomes 0, and write the ledger immediately (not only on fulfill).

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

    IF public.has_month_monthly_gift_claim(v_uid, v_month) THEN
        RAISE EXCEPTION 'You can redeem only one monthly gift per month (catalog or dinner)';
    END IF;

    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := public.get_available_weightage(v_uid, v_month);
    v_need := COALESCE(v_item.weightage_required, 0);

    IF v_available IS NULL THEN
        RAISE EXCEPTION 'No KPI weightage for this month yet';
    END IF;
    IF v_available < v_need THEN
        RAISE EXCEPTION 'Need at least % available weightage this month (you have % available, % earned)',
            trim(to_char(v_need, 'FM999990.#######')) || '%',
            trim(to_char(v_available, 'FM999990.#######')) || '%',
            trim(to_char(COALESCE(v_earned, 0), 'FM999990.#######')) || '%';
    END IF;

    -- Spend all remaining available weightage so current becomes 0.
    v_cost := v_available;

    INSERT INTO public.reward_redemptions (
        employee_id, reward_id, points_used, weightage_at_claim, weightage_cost, status
    )
    VALUES (v_uid, p_reward_id, 0, v_available, v_cost, 'pending')
    RETURNING id INTO v_id;

    PERFORM public.record_weightage_deduction(
        v_uid,
        v_me.company_id,
        v_month,
        v_cost,
        'catalog',
        v_id,
        'Redeemed catalog: ' || COALESCE(v_item.name, 'reward')
    );

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
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 95);
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
        -- Spend all available so current weightage becomes 0.
        v_cost := v_available;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — used ' || round(COALESCE(v_cost, 0), 2)::TEXT || '% weightage in '
            || to_char(v_month, 'Mon YYYY') || '.';
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

    IF v_key = 'dinner_voucher' AND COALESCE(v_cost, 0) > 0 THEN
        PERFORM public.record_weightage_deduction(
            v_uid,
            v_me.company_id,
            v_month,
            v_cost,
            'kpi_award',
            v_id,
            'Redeemed: ' || v_name
        );
    END IF;

    PERFORM public.create_system_notification(
        v_uid,
        'Gift request submitted',
        'Your request for ' || v_name || ' was sent for approval.'
            || CASE WHEN v_key = 'dinner_voucher' THEN ' Your available weightage is now 0%.' ELSE '' END,
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

-- Fulfill must not double-count: ledger unique on source; reserved excludes fulfilled ledger.
-- Update reserved to ignore rows already in ledger (deducted on redeem).
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
      AND r.status IN ('pending', 'approved')
      AND NOT EXISTS (
          SELECT 1 FROM public.reward_weightage_ledger l
          WHERE l.source_kind = 'catalog' AND l.source_id = r.id
      );

    SELECT COALESCE(SUM(COALESCE(q.weightage_cost, 0)), 0)
    INTO v_kpi
    FROM public.kpi_award_qualifications q
    WHERE q.employee_id = p_user_id
      AND q.period_end = v_month
      AND q.status IN ('pending', 'approved', 'pending_fulfillment')
      AND NOT EXISTS (
          SELECT 1 FROM public.reward_weightage_ledger l
          WHERE l.source_kind = 'kpi_award' AND l.source_id = q.id
      );

    RETURN ROUND(COALESCE(v_cat, 0) + COALESCE(v_kpi, 0), 2);
END;
$$;

-- Backfill ledger for existing pending monthly claims that never wrote a deduction.
INSERT INTO public.reward_weightage_ledger (
    employee_id, company_id, month, amount, source_kind, source_id, note
)
SELECT
    q.employee_id,
    q.company_id,
    q.period_end,
    GREATEST(
      COALESCE(NULLIF(q.weightage_cost, 0), 0),
      COALESCE(NULLIF(q.latest_score, 0), 0)
    ),
    'kpi_award',
    q.id,
    'Backfill redeem: ' || q.reward_name
FROM public.kpi_award_qualifications q
WHERE q.rule_key = 'dinner_voucher'
  AND q.status IS DISTINCT FROM 'dismissed'
  AND GREATEST(
        COALESCE(NULLIF(q.weightage_cost, 0), 0),
        COALESCE(NULLIF(q.latest_score, 0), 0)
      ) > 0
  AND NOT EXISTS (
      SELECT 1 FROM public.reward_weightage_ledger l
      WHERE l.source_kind = 'kpi_award' AND l.source_id = q.id
  );

-- For dinner rows that stored only min cost, upgrade cost to full claim weightage when possible.
UPDATE public.kpi_award_qualifications q
SET weightage_cost = COALESCE(NULLIF(q.latest_score, 0), q.weightage_cost)
WHERE q.rule_key = 'dinner_voucher'
  AND q.status IS DISTINCT FROM 'dismissed'
  AND COALESCE(q.latest_score, 0) > COALESCE(q.weightage_cost, 0);

UPDATE public.reward_weightage_ledger l
SET amount = q.weightage_cost
FROM public.kpi_award_qualifications q
WHERE l.source_kind = 'kpi_award'
  AND l.source_id = q.id
  AND q.rule_key = 'dinner_voucher'
  AND COALESCE(q.weightage_cost, 0) > l.amount
  AND COALESCE(q.weightage_cost, 0) > 0;

INSERT INTO public.reward_weightage_ledger (
    employee_id, company_id, month, amount, source_kind, source_id, note
)
SELECT
    r.employee_id,
    u.company_id,
    date_trunc('month', (timezone('Asia/Karachi', r.redeemed_at))::DATE)::DATE,
    GREATEST(
      COALESCE(NULLIF(r.weightage_cost, 0), 0),
      COALESCE(NULLIF(r.weightage_at_claim, 0), 0),
      COALESCE(NULLIF(c.weightage_required, 0), 0)
    ),
    'catalog',
    r.id,
    'Backfill redeem catalog'
FROM public.reward_redemptions r
JOIN public.users u ON u.id = r.employee_id
LEFT JOIN public.rewards_catalog c ON c.id = r.reward_id
WHERE r.status IS DISTINCT FROM 'dismissed'
  AND u.company_id IS NOT NULL
  AND GREATEST(
        COALESCE(NULLIF(r.weightage_cost, 0), 0),
        COALESCE(NULLIF(r.weightage_at_claim, 0), 0),
        COALESCE(NULLIF(c.weightage_required, 0), 0)
      ) > 0
  AND NOT EXISTS (
      SELECT 1 FROM public.reward_weightage_ledger l
      WHERE l.source_kind = 'catalog' AND l.source_id = r.id
  );

GRANT EXECUTE ON FUNCTION public.redeem_catalog_reward(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_weightage_reserved(UUID, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
