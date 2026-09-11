-- Allow redeeming dinner / catalog using Banked weightage (explicit opt-in).

CREATE OR REPLACE FUNCTION public.gift_weightage_already_paid(p_source_kind TEXT, p_source_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.reward_weightage_ledger
      WHERE source_kind = p_source_kind AND source_id = p_source_id
  ) OR EXISTS (
      SELECT 1 FROM public.reward_weightage_bank_ledger
      WHERE source_kind = p_source_kind
        AND source_id = p_source_id
        AND movement = 'spend'
  );
$$;

DROP FUNCTION IF EXISTS public.redeem_catalog_reward(UUID);
DROP FUNCTION IF EXISTS public.claim_my_kpi_award(TEXT);

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

    IF public.has_month_monthly_gift_claim(v_uid, v_month) THEN
        RAISE EXCEPTION 'You can redeem only one monthly gift per month (catalog or dinner)';
    END IF;

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
    PERFORM public.notify_company_award_staff(
        v_me.company_id,
        'Gift request: ' || COALESCE(v_me.full_name, 'Employee'),
        v_detail
    );

    RETURN v_id;
END;
$$;

-- Fulfill must not charge again when already paid from month or bank.
CREATE OR REPLACE FUNCTION public.set_kpi_award_status(p_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.kpi_award_qualifications%ROWTYPE;
    v_status TEXT := lower(trim(COALESCE(p_status, '')));
    v_me public.users%ROWTYPE;
    v_cfg public.kpi_award_config;
    v_cost NUMERIC;
    v_prev TEXT;
    v_refunded NUMERIC := 0;
BEGIN
    IF v_status IN ('pending_fulfillment') THEN v_status := 'pending'; END IF;
    IF v_status IN ('fulfilled') THEN v_status := 'issued'; END IF;
    IF v_status IN ('rejected', 'reject') THEN v_status := 'dismissed'; END IF;
    IF v_status NOT IN ('pending', 'approved', 'issued', 'dismissed') THEN
        RAISE EXCEPTION 'Invalid status';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    SELECT * INTO v_row FROM public.kpi_award_qualifications WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Award not found'; END IF;
    IF v_row.company_id IS DISTINCT FROM public.current_company_id() THEN
        RAISE EXCEPTION 'Award is not in your company';
    END IF;

    IF NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT (
            v_me.role = 'manager'::public.user_role
            AND public.is_manager_of(auth.uid(), v_row.employee_id)
       ) THEN
        RAISE EXCEPTION 'Not authorized to update this milestone';
    END IF;

    v_prev := v_row.status;

    IF v_status = 'dismissed' AND v_prev IN ('issued', 'fulfilled') THEN
        RAISE EXCEPTION 'Cannot reject a gift that was already delivered';
    END IF;

    UPDATE public.kpi_award_qualifications
    SET status = v_status, decided_at = timezone('utc'::text, now()), decided_by = auth.uid()
    WHERE id = p_id;

    IF v_status = 'dismissed' AND v_prev IS DISTINCT FROM 'dismissed' THEN
        v_refunded := public.refund_weightage_deduction('kpi_award', v_row.id);
        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Gift request rejected',
            'Your request for ' || v_row.reward_name || ' was rejected.'
                || CASE
                    WHEN v_refunded > 0 THEN
                        ' ' || trim(to_char(v_refunded, 'FM999990.#######'))
                        || '% weightage was returned.'
                    ELSE ''
                END,
            'warning'
        );
        RETURN;
    END IF;

    IF v_status = 'issued' AND v_prev IS DISTINCT FROM 'issued' THEN
        v_cfg := public.ensure_kpi_award_config(v_row.company_id);
        v_cost := COALESCE(
            v_row.weightage_cost,
            CASE v_row.rule_key
                WHEN 'dinner_voucher' THEN v_cfg.dinner_min_pct
                WHEN 'movie_tickets' THEN v_cfg.movie_min_pct
                WHEN 'surprise_gift' THEN v_cfg.gift_min_pct
                ELSE NULL
            END
        );
        IF v_row.rule_key = 'dinner_voucher'
           AND COALESCE(v_cost, 0) > 0
           AND NOT public.gift_weightage_already_paid('kpi_award', v_row.id) THEN
            PERFORM public.record_weightage_deduction(
                v_row.employee_id,
                v_row.company_id,
                v_row.period_end,
                v_cost,
                'kpi_award',
                v_row.id,
                'Fulfilled: ' || v_row.reward_name
            );
        END IF;
        UPDATE public.kpi_award_qualifications
        SET weightage_cost = COALESCE(weightage_cost, v_cost)
        WHERE id = p_id;
    END IF;

    IF v_status IN ('approved', 'issued') THEN
        PERFORM public.create_system_notification(
            v_row.employee_id,
            CASE WHEN v_status = 'issued' THEN 'Milestone fulfilled' ELSE 'Milestone approved' END,
            CASE
                WHEN v_status = 'issued' THEN
                    'Your reward: ' || v_row.reward_name || ' was delivered.'
                ELSE 'Your reward: ' || v_row.reward_name || ' was approved.'
            END,
            'info'
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_catalog_redemption_status(p_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.reward_redemptions%ROWTYPE;
    v_item public.rewards_catalog%ROWTYPE;
    v_status TEXT := lower(trim(COALESCE(p_status, '')));
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_cost NUMERIC;
    v_prev TEXT;
    v_month DATE;
    v_refunded NUMERIC := 0;
BEGIN
    IF v_status IN ('dismissed', 'reject') THEN v_status := 'rejected'; END IF;
    IF v_status NOT IN ('pending', 'approved', 'fulfilled', 'rejected') THEN
        RAISE EXCEPTION 'Invalid status';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    SELECT * INTO v_row FROM public.reward_redemptions WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Redemption not found'; END IF;
    SELECT * INTO v_emp FROM public.users WHERE id = v_row.employee_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
    IF v_emp.company_id IS DISTINCT FROM public.current_company_id() THEN
        RAISE EXCEPTION 'Redemption is not in your company';
    END IF;

    IF NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT (
            v_me.role = 'manager'::public.user_role
            AND public.is_manager_of(auth.uid(), v_row.employee_id)
       ) THEN
        RAISE EXCEPTION 'Not authorized to update this redemption';
    END IF;

    v_prev := v_row.status;

    IF v_status = 'rejected' AND v_prev = 'fulfilled' THEN
        RAISE EXCEPTION 'Cannot reject a gift that was already delivered';
    END IF;

    UPDATE public.reward_redemptions
    SET status = v_status
    WHERE id = p_id;

    IF v_status = 'rejected' AND v_prev IS DISTINCT FROM 'rejected' THEN
        v_refunded := public.refund_weightage_deduction('catalog', v_row.id);
        SELECT * INTO v_item FROM public.rewards_catalog WHERE id = v_row.reward_id;
        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Catalog reward rejected',
            'Your request for ' || COALESCE(v_item.name, 'a catalog reward') || ' was rejected.'
                || CASE
                    WHEN v_refunded > 0 THEN
                        ' ' || trim(to_char(v_refunded, 'FM999990.#######'))
                        || '% weightage was returned.'
                    ELSE ''
                END,
            'warning'
        );
        RETURN;
    END IF;

    IF v_status = 'fulfilled' AND v_prev IS DISTINCT FROM 'fulfilled' THEN
        SELECT * INTO v_item FROM public.rewards_catalog WHERE id = v_row.reward_id;
        v_cost := COALESCE(v_row.weightage_cost, v_item.weightage_required, 0);
        v_month := date_trunc('month', (timezone('Asia/Karachi', v_row.redeemed_at))::DATE)::DATE;
        IF COALESCE(v_cost, 0) > 0
           AND NOT public.gift_weightage_already_paid('catalog', v_row.id) THEN
            PERFORM public.record_weightage_deduction(
                v_row.employee_id,
                v_emp.company_id,
                v_month,
                v_cost,
                'catalog',
                v_row.id,
                'Fulfilled catalog: ' || COALESCE(v_item.name, 'reward')
            );
        END IF;
        UPDATE public.reward_redemptions
        SET weightage_cost = COALESCE(weightage_cost, v_cost)
        WHERE id = p_id;

        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Catalog reward fulfilled',
            'Your reward was delivered.',
            'info'
        );
    ELSIF v_status = 'approved' AND v_prev IS DISTINCT FROM 'approved' THEN
        SELECT * INTO v_item FROM public.rewards_catalog WHERE id = v_row.reward_id;
        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Catalog reward approved',
            'Your request for ' || COALESCE(v_item.name, 'a catalog reward') || ' was approved.',
            'info'
        );
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_catalog_reward(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_kpi_award_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_catalog_redemption_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gift_weightage_already_paid(TEXT, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
