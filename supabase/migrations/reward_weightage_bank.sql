-- Monthly gifts: charge gift requirement only; leftover Current → Banked (cross-month).
-- Qualify on this month alone; Banked may help pay the cost.

CREATE TABLE IF NOT EXISTS public.reward_weightage_bank_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    amount NUMERIC(8, 2) NOT NULL,
    movement TEXT NOT NULL CHECK (movement IN ('deposit', 'spend')),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('catalog', 'kpi_award')),
    source_id UUID NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    UNIQUE (source_kind, source_id, movement)
);

CREATE INDEX IF NOT EXISTS idx_reward_weightage_bank_ledger_employee
    ON public.reward_weightage_bank_ledger (employee_id);

ALTER TABLE public.reward_weightage_bank_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reward_weightage_bank_ledger FROM anon, public;
GRANT SELECT ON TABLE public.reward_weightage_bank_ledger TO authenticated;

DROP POLICY IF EXISTS reward_weightage_bank_ledger_select ON public.reward_weightage_bank_ledger;
CREATE POLICY reward_weightage_bank_ledger_select ON public.reward_weightage_bank_ledger
  FOR SELECT TO authenticated
  USING (
    employee_id = auth.uid()
    OR (public.can_manage_org_shifts(auth.uid()) AND company_id = public.current_company_id())
    OR public.is_manager_of(auth.uid(), employee_id)
  );

-- Allow month-ledger rows that move leftover out of Current into Banked.
ALTER TABLE public.reward_weightage_ledger
  DROP CONSTRAINT IF EXISTS reward_weightage_ledger_source_kind_check;

ALTER TABLE public.reward_weightage_ledger
  ADD CONSTRAINT reward_weightage_ledger_source_kind_check
  CHECK (source_kind IN ('catalog', 'kpi_award', 'bank_move'));

-- Amount can exceed 100 when combining (should not), but bank moves are small;
-- keep 0–100 for month ledger.
ALTER TABLE public.reward_weightage_ledger
  DROP CONSTRAINT IF EXISTS reward_weightage_ledger_amount_check;

ALTER TABLE public.reward_weightage_ledger
  ADD CONSTRAINT reward_weightage_ledger_amount_check
  CHECK (amount > 0 AND amount <= 100);

CREATE OR REPLACE FUNCTION public.get_banked_weightage(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sum NUMERIC;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM public.reward_weightage_bank_ledger
    WHERE employee_id = p_user_id;
    RETURN ROUND(COALESCE(v_sum, 0), 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_weightage_gift_used(p_user_id UUID, p_month DATE DEFAULT NULL)
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
    v_sum NUMERIC;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM public.reward_weightage_ledger
    WHERE employee_id = p_user_id
      AND month = v_month
      AND source_kind IN ('catalog', 'kpi_award');
    RETURN ROUND(COALESCE(v_sum, 0), 2);
END;
$$;

-- Available = earned − gift spends − banked-out leftovers (all month ledger rows).
CREATE OR REPLACE FUNCTION public.get_weightage_deducted(p_user_id UUID, p_month DATE DEFAULT NULL)
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
    v_sum NUMERIC;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM public.reward_weightage_ledger
    WHERE employee_id = p_user_id
      AND month = v_month;
    RETURN ROUND(COALESCE(v_sum, 0), 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_deposit(
    p_employee_id UUID,
    p_company_id UUID,
    p_amount NUMERIC,
    p_source_kind TEXT,
    p_source_id UUID,
    p_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_amount NUMERIC := ROUND(GREATEST(0, COALESCE(p_amount, 0)), 2);
BEGIN
    IF v_amount <= 0 THEN
        RETURN;
    END IF;
    INSERT INTO public.reward_weightage_bank_ledger (
        employee_id, company_id, amount, movement, source_kind, source_id, note, created_by
    )
    VALUES (
        p_employee_id, p_company_id, v_amount, 'deposit', p_source_kind, p_source_id, p_note, auth.uid()
    )
    ON CONFLICT (source_kind, source_id, movement) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_spend(
    p_employee_id UUID,
    p_company_id UUID,
    p_amount NUMERIC,
    p_source_kind TEXT,
    p_source_id UUID,
    p_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_amount NUMERIC := ROUND(GREATEST(0, COALESCE(p_amount, 0)), 2);
    v_bank NUMERIC;
BEGIN
    IF v_amount <= 0 THEN
        RETURN;
    END IF;
    v_bank := public.get_banked_weightage(p_employee_id);
    IF v_bank < v_amount THEN
        RAISE EXCEPTION 'Insufficient banked weightage (need %, have %)',
            trim(to_char(v_amount, 'FM999990.#######')) || '%',
            trim(to_char(v_bank, 'FM999990.#######')) || '%';
    END IF;
    INSERT INTO public.reward_weightage_bank_ledger (
        employee_id, company_id, amount, movement, source_kind, source_id, note, created_by
    )
    VALUES (
        p_employee_id, p_company_id, -v_amount, 'spend', p_source_kind, p_source_id, p_note, auth.uid()
    )
    ON CONFLICT (source_kind, source_id, movement) DO NOTHING;
END;
$$;

-- Pay gift cost from Current then Bank; move leftover Current into Banked (Current → 0).
CREATE OR REPLACE FUNCTION public.pay_monthly_gift_weightage(
    p_employee_id UUID,
    p_company_id UUID,
    p_month DATE,
    p_available NUMERIC,
    p_cost NUMERIC,
    p_source_kind TEXT,
    p_source_id UUID,
    p_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc('month', p_month)::DATE;
    v_available NUMERIC := ROUND(GREATEST(0, COALESCE(p_available, 0)), 2);
    v_cost NUMERIC := ROUND(GREATEST(0, COALESCE(p_cost, 0)), 2);
    v_bank NUMERIC;
    v_from_month NUMERIC;
    v_from_bank NUMERIC;
    v_leftover NUMERIC;
BEGIN
    IF v_cost <= 0 THEN
        RETURN;
    END IF;

    v_bank := public.get_banked_weightage(p_employee_id);
    IF v_available + v_bank < v_cost THEN
        RAISE EXCEPTION 'Need % total weightage to pay this gift (current % + banked %)',
            trim(to_char(v_cost, 'FM999990.#######')) || '%',
            trim(to_char(v_available, 'FM999990.#######')) || '%',
            trim(to_char(v_bank, 'FM999990.#######')) || '%';
    END IF;

    v_from_month := LEAST(v_cost, v_available);
    v_from_bank := ROUND(v_cost - v_from_month, 2);
    v_leftover := ROUND(v_available - v_from_month, 2);

    IF v_from_month > 0 THEN
        PERFORM public.record_weightage_deduction(
            p_employee_id,
            p_company_id,
            v_month,
            v_from_month,
            p_source_kind,
            p_source_id,
            COALESCE(p_note, 'Gift cost')
        );
    END IF;

    IF v_from_bank > 0 THEN
        PERFORM public.bank_spend(
            p_employee_id,
            p_company_id,
            v_from_bank,
            p_source_kind,
            p_source_id,
            'Paid from banked weightage'
        );
    END IF;

    IF v_leftover > 0 THEN
        -- Remove leftover from Current (does not count as Used gift spend).
        INSERT INTO public.reward_weightage_ledger (
            employee_id, company_id, month, amount, source_kind, source_id, note, created_by
        )
        VALUES (
            p_employee_id,
            p_company_id,
            v_month,
            v_leftover,
            'bank_move',
            p_source_id,
            'Moved leftover to bank',
            auth.uid()
        )
        ON CONFLICT (source_kind, source_id) DO NOTHING;

        PERFORM public.bank_deposit(
            p_employee_id,
            p_company_id,
            v_leftover,
            p_source_kind,
            p_source_id,
            'Leftover after monthly gift'
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_weightage_deduction(
    p_source_kind TEXT,
    p_source_id UUID
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_gift NUMERIC := 0;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_gift
    FROM public.reward_weightage_ledger
    WHERE source_kind = p_source_kind
      AND source_id = p_source_id;

    DELETE FROM public.reward_weightage_ledger
    WHERE source_id = p_source_id
      AND (source_kind = p_source_kind OR source_kind = 'bank_move');

    DELETE FROM public.reward_weightage_bank_ledger
    WHERE source_kind = p_source_kind
      AND source_id = p_source_id;

    RETURN ROUND(COALESCE(v_gift, 0), 2);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_weightage_deduction(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_deposit(UUID, UUID, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_spend(UUID, UUID, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_monthly_gift_weightage(UUID, UUID, DATE, NUMERIC, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.get_month_weightage_balance(UUID);

CREATE OR REPLACE FUNCTION public.get_month_weightage_balance(p_user_id UUID DEFAULT NULL)
RETURNS TABLE (
    month DATE,
    earned NUMERIC,
    deducted NUMERIC,
    available NUMERIC,
    banked NUMERIC
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
    v_gift_used NUMERIC;
    v_reserved NUMERIC;
    v_all_out NUMERIC;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Not allowed';
    END IF;

    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_gift_used := public.get_weightage_gift_used(v_uid, v_month);
    v_reserved := public.get_weightage_reserved(v_uid, v_month);
    v_all_out := public.get_weightage_deducted(v_uid, v_month);

    month := v_month;
    earned := v_earned;
    -- Used = gift spends (+ reserved not yet ledgered).
    deducted := ROUND(COALESCE(v_gift_used, 0) + COALESCE(v_reserved, 0), 2);
    available := CASE
        WHEN v_earned IS NULL THEN NULL
        ELSE GREATEST(0, ROUND(v_earned - COALESCE(v_all_out, 0) - COALESCE(v_reserved, 0), 2))
    END;
    banked := public.get_banked_weightage(v_uid);
    RETURN NEXT;
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
    v_cost := v_need;

    IF v_available IS NULL THEN
        RAISE EXCEPTION 'No KPI weightage for this month yet';
    END IF;
    -- Qualify on this month alone (bank does not help qualify).
    IF v_available < v_need THEN
        RAISE EXCEPTION 'Need at least % available weightage this month (you have % available, % earned)',
            trim(to_char(v_need, 'FM999990.#######')) || '%',
            trim(to_char(v_available, 'FM999990.#######')) || '%',
            trim(to_char(COALESCE(v_earned, 0), 'FM999990.#######')) || '%';
    END IF;

    INSERT INTO public.reward_redemptions (
        employee_id, reward_id, points_used, weightage_at_claim, weightage_cost, status
    )
    VALUES (v_uid, p_reward_id, 0, v_available, v_cost, 'pending')
    RETURNING id INTO v_id;

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
    v_leftover NUMERIC;
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
        v_cost := v_cfg.dinner_min_pct;
        v_leftover := GREATEST(0, ROUND(COALESCE(v_available, 0) - v_cost, 2));
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — used ' || round(COALESCE(v_cost, 0), 2)::TEXT || '% weightage in '
            || to_char(v_month, 'Mon YYYY')
            || CASE
                WHEN v_leftover > 0 THEN
                    '; ' || round(v_leftover, 2)::TEXT || '% moved to banked.'
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

    PERFORM public.create_system_notification(
        v_uid,
        'Gift request submitted',
        'Your request for ' || v_name || ' was sent for approval.'
            || CASE
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

-- Progress copy: dinner uses min cost; leftover banks.
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
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 95);
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
            'Streak complete — redeem anytime this month (allowed with one monthly gift).'
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
    qualified := v_dinner >= 1 AND NOT v_monthly_claimed;
    hint := CASE
        WHEN v_monthly_claimed THEN 'You already redeemed a monthly gift this month (catalog or dinner).'
        WHEN v_dinner >= 1 THEN
            'Qualified — uses '
            || trim(to_char(v_cfg.dinner_min_pct, 'FM999990.#######'))
            || '%; leftover moves to banked weightage.'
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
    qualified := v_gift >= v_cfg.gift_months AND NOT v_streak_claimed;
    hint := CASE
        WHEN v_streak_claimed THEN 'You already redeemed a 3-month or 6-month gift this month.'
        WHEN v_gift >= v_cfg.gift_months THEN
            'Streak complete — redeem anytime this month (allowed with one monthly gift).'
        WHEN v_gift = 0 THEN
            'Need ' || v_cfg.gift_months::TEXT || ' months in a row at earned weightage ' || v_gift_band || '%.'
        ELSE v_gift::TEXT || ' of ' || v_cfg.gift_months::TEXT || ' months in a row at ' || v_gift_band || '%.'
    END;
    RETURN NEXT;
END;
$$;

-- Backfill: shrink past full-spend ledger to gift requirement; deposit excess to bank.
DO $$
DECLARE
    r RECORD;
    v_need NUMERIC;
    v_excess NUMERIC;
    v_cfg public.kpi_award_config;
BEGIN
    FOR r IN
        SELECT l.*, q.rule_key, q.company_id AS q_company, q.status AS q_status, q.weightage_cost AS q_cost
        FROM public.reward_weightage_ledger l
        JOIN public.kpi_award_qualifications q ON q.id = l.source_id
        WHERE l.source_kind = 'kpi_award'
          AND q.rule_key = 'dinner_voucher'
          AND q.status IS DISTINCT FROM 'dismissed'
    LOOP
        v_cfg := public.ensure_kpi_award_config(r.q_company);
        -- True gift cost is dinner_min (ignore inflated full-spend weightage_cost).
        v_need := COALESCE(v_cfg.dinner_min_pct, 0);
        IF r.amount > v_need AND v_need > 0 THEN
            v_excess := ROUND(r.amount - v_need, 2);
            UPDATE public.reward_weightage_ledger
            SET amount = v_need
            WHERE id = r.id;
            UPDATE public.kpi_award_qualifications
            SET weightage_cost = v_need
            WHERE id = r.source_id;
            PERFORM public.bank_deposit(
                r.employee_id,
                r.company_id,
                v_excess,
                'kpi_award',
                r.source_id,
                'Backfill leftover from full-spend redeem'
            );
            INSERT INTO public.reward_weightage_ledger (
                employee_id, company_id, month, amount, source_kind, source_id, note
            )
            VALUES (
                r.employee_id, r.company_id, r.month, v_excess, 'bank_move', r.source_id,
                'Backfill: leftover moved to bank'
            )
            ON CONFLICT (source_kind, source_id) DO NOTHING;
        END IF;
    END LOOP;

    FOR r IN
        SELECT l.*, c.weightage_required, red.weightage_cost AS r_cost, red.status AS r_status, u.company_id AS u_company
        FROM public.reward_weightage_ledger l
        JOIN public.reward_redemptions red ON red.id = l.source_id
        JOIN public.users u ON u.id = red.employee_id
        LEFT JOIN public.rewards_catalog c ON c.id = red.reward_id
        WHERE l.source_kind = 'catalog'
          AND red.status IS DISTINCT FROM 'rejected'
    LOOP
        v_need := COALESCE(NULLIF(r.weightage_required, 0), 0);
        IF v_need > 0 AND r.amount > v_need THEN
            v_excess := ROUND(r.amount - v_need, 2);
            UPDATE public.reward_weightage_ledger
            SET amount = v_need
            WHERE id = r.id;
            UPDATE public.reward_redemptions
            SET weightage_cost = v_need
            WHERE id = r.source_id;
            PERFORM public.bank_deposit(
                r.employee_id,
                COALESCE(r.company_id, r.u_company),
                v_excess,
                'catalog',
                r.source_id,
                'Backfill leftover from full-spend catalog redeem'
            );
            INSERT INTO public.reward_weightage_ledger (
                employee_id, company_id, month, amount, source_kind, source_id, note
            )
            VALUES (
                r.employee_id,
                COALESCE(r.company_id, r.u_company),
                r.month,
                v_excess,
                'bank_move',
                r.source_id,
                'Backfill: leftover moved to bank'
            )
            ON CONFLICT (source_kind, source_id) DO NOTHING;
        END IF;
    END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.get_banked_weightage(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_weightage_gift_used(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_weightage_deducted(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_available_weightage(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_month_weightage_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_catalog_reward(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
