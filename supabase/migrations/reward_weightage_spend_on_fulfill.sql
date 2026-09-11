-- Spendable monthly weightage: deduct on gift fulfill; streaks still use earned score.
-- Available = earned − deducted. One gift claim per employee per calendar month.

CREATE TABLE IF NOT EXISTS public.reward_weightage_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    month DATE NOT NULL,
    amount NUMERIC(5, 2) NOT NULL CHECK (amount > 0 AND amount <= 100),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('catalog', 'kpi_award')),
    source_id UUID NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    UNIQUE (source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS idx_reward_weightage_ledger_employee_month
    ON public.reward_weightage_ledger (employee_id, month);

ALTER TABLE public.reward_weightage_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reward_weightage_ledger FROM anon, public;
GRANT SELECT ON TABLE public.reward_weightage_ledger TO authenticated;

DROP POLICY IF EXISTS reward_weightage_ledger_select ON public.reward_weightage_ledger;
CREATE POLICY reward_weightage_ledger_select ON public.reward_weightage_ledger
  FOR SELECT TO authenticated
  USING (
    employee_id = auth.uid()
    OR (public.can_manage_org_shifts(auth.uid()) AND company_id = public.current_company_id())
    OR public.is_manager_of(auth.uid(), employee_id)
  );

ALTER TABLE public.reward_redemptions
  ADD COLUMN IF NOT EXISTS weightage_cost NUMERIC(5, 2);

ALTER TABLE public.kpi_award_qualifications
  ADD COLUMN IF NOT EXISTS weightage_cost NUMERIC(5, 2);

-- Earned weightage this month (unchanged formula; used for streaks).
-- Deducted / available helpers:

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
    RETURN GREATEST(0, ROUND(v_earned - public.get_weightage_deducted(p_user_id, v_month), 2));
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
    month := v_month;
    earned := v_earned;
    deducted := v_deducted;
    available := CASE
        WHEN v_earned IS NULL THEN NULL
        ELSE GREATEST(0, ROUND(v_earned - v_deducted, 2))
    END;
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_month_gift_claim(p_user_id UUID, p_month DATE DEFAULT NULL)
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
          AND q.status IS DISTINCT FROM 'dismissed'
    ) INTO v_hit;
    RETURN COALESCE(v_hit, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_weightage_deduction(
    p_employee_id UUID,
    p_company_id UUID,
    p_month DATE,
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
    v_amount NUMERIC := ROUND(GREATEST(0, LEAST(100, COALESCE(p_amount, 0))), 2);
    v_month DATE := date_trunc('month', p_month)::DATE;
BEGIN
    IF v_amount <= 0 THEN
        RETURN;
    END IF;
    INSERT INTO public.reward_weightage_ledger (
        employee_id, company_id, month, amount, source_kind, source_id, note, created_by
    )
    VALUES (
        p_employee_id,
        p_company_id,
        v_month,
        v_amount,
        p_source_kind,
        p_source_id,
        p_note,
        auth.uid()
    )
    ON CONFLICT (source_kind, source_id) DO NOTHING;
END;
$$;

-- Catalog redeem: gate on available weightage; one gift per month.
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

    IF public.has_month_gift_claim(v_uid, v_month) THEN
        RAISE EXCEPTION 'You can redeem only one gift per month';
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

-- Company gift claim: dinner uses available band; streaks use earned months.
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

    IF public.has_month_gift_claim(v_uid, v_month) THEN
        RAISE EXCEPTION 'You can redeem only one gift per month';
    END IF;

    IF v_key = 'dinner_voucher' THEN
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
        -- Streak months use earned weightage so dinner spend does not break prior months.
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets'
        );
        IF v_streak < v_cfg.movie_months THEN
            RAISE EXCEPTION 'Keep earned weightage in the movie-ticket band for % months in a row first', v_cfg.movie_months;
        END IF;
        IF v_available IS NULL OR v_available < v_cfg.movie_min_pct THEN
            RAISE EXCEPTION 'Need at least % available weightage to redeem movie tickets (you have %)',
                trim(to_char(v_cfg.movie_min_pct, 'FM999990.#######')) || '%',
                trim(to_char(COALESCE(v_available, 0), 'FM999990.#######')) || '%';
        END IF;
        v_name := v_cfg.movie_reward_name;
        v_months := v_streak;
        v_cost := v_cfg.movie_min_pct;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.movie_min_pct::TEXT || '–' || v_cfg.movie_max_pct::TEXT
            || '% weightage for ' || v_cfg.movie_months::TEXT || ' consecutive months.';
    ELSE
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift'
        );
        IF v_streak < v_cfg.gift_months THEN
            RAISE EXCEPTION 'Keep earned weightage in the surprise-gift band for % months in a row first', v_cfg.gift_months;
        END IF;
        IF v_available IS NULL OR v_available < v_cfg.gift_min_pct THEN
            RAISE EXCEPTION 'Need at least % available weightage to redeem the surprise gift (you have %)',
                trim(to_char(v_cfg.gift_min_pct, 'FM999990.#######')) || '%',
                trim(to_char(COALESCE(v_available, 0), 'FM999990.#######')) || '%';
        END IF;
        v_name := v_cfg.gift_reward_name;
        v_months := v_streak;
        v_cost := v_cfg.gift_min_pct;
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

-- Progress UI: latest_score = available weightage (for redeem display).
-- Streak counters still use earned months via kpi_award_consecutive_months.
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
    v_month_claimed BOOLEAN;
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
    v_month_claimed := public.has_month_gift_claim(v_uid, v_month);

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
        AND COALESCE(v_available, 0) >= v_cfg.movie_min_pct
        AND NOT v_month_claimed;
    hint := CASE
        WHEN v_month_claimed THEN 'You already redeemed a gift this month.'
        WHEN v_movie >= v_cfg.movie_months AND COALESCE(v_available, 0) >= v_cfg.movie_min_pct THEN
            'You met the streak — tap Redeem (uses ' || trim(to_char(v_cfg.movie_min_pct, 'FM999990.#######')) || '% available weightage).'
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
    qualified := v_dinner >= 1 AND NOT v_month_claimed;
    hint := CASE
        WHEN v_month_claimed THEN 'You already redeemed a gift this month.'
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
        AND COALESCE(v_available, 0) >= v_cfg.gift_min_pct
        AND NOT v_month_claimed;
    hint := CASE
        WHEN v_month_claimed THEN 'You already redeemed a gift this month.'
        WHEN v_gift >= v_cfg.gift_months AND COALESCE(v_available, 0) >= v_cfg.gift_min_pct THEN
            'You met the streak — tap Redeem (uses ' || trim(to_char(v_cfg.gift_min_pct, 'FM999990.#######')) || '% available weightage).'
        WHEN v_gift = 0 THEN
            'Need ' || v_cfg.gift_months::TEXT || ' months in a row at earned weightage ' || v_gift_band || '%.'
        ELSE v_gift::TEXT || ' of ' || v_cfg.gift_months::TEXT || ' months at earned weightage ' || v_gift_band || '%.'
    END;
    RETURN NEXT;
END;
$$;

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
BEGIN
    IF v_status IN ('pending_fulfillment') THEN v_status := 'pending'; END IF;
    IF v_status IN ('fulfilled') THEN v_status := 'issued'; END IF;
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

    UPDATE public.kpi_award_qualifications
    SET status = v_status, decided_at = timezone('utc'::text, now()), decided_by = auth.uid()
    WHERE id = p_id;

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
        PERFORM public.record_weightage_deduction(
            v_row.employee_id,
            v_row.company_id,
            v_row.period_end,
            v_cost,
            'kpi_award',
            v_row.id,
            'Fulfilled: ' || v_row.reward_name
        );
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
                    'Your reward: ' || v_row.reward_name || '. '
                    || trim(to_char(COALESCE(v_cost, v_row.weightage_cost, 0), 'FM999990.#######'))
                    || '% weightage was deducted from this month.'
                ELSE 'Your reward: ' || v_row.reward_name
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
BEGIN
    IF v_status NOT IN ('pending', 'approved', 'fulfilled') THEN
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
    UPDATE public.reward_redemptions
    SET status = v_status
    WHERE id = p_id;

    IF v_status = 'fulfilled' AND v_prev IS DISTINCT FROM 'fulfilled' THEN
        SELECT * INTO v_item FROM public.rewards_catalog WHERE id = v_row.reward_id;
        v_cost := COALESCE(v_row.weightage_cost, v_item.weightage_required, 0);
        v_month := date_trunc('month', (timezone('Asia/Karachi', v_row.redeemed_at))::DATE)::DATE;
        PERFORM public.record_weightage_deduction(
            v_row.employee_id,
            v_emp.company_id,
            v_month,
            v_cost,
            'catalog',
            v_row.id,
            'Fulfilled catalog: ' || COALESCE(v_item.name, 'reward')
        );
        UPDATE public.reward_redemptions
        SET weightage_cost = COALESCE(weightage_cost, v_cost)
        WHERE id = p_id;

        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Catalog reward fulfilled',
            'Your reward was delivered. '
                || trim(to_char(COALESCE(v_cost, 0), 'FM999990.#######'))
                || '% weightage was deducted from this month.',
            'info'
        );
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_weightage_deducted(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_available_weightage(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_month_weightage_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_month_gift_claim(UUID, DATE) TO authenticated;
REVOKE ALL ON FUNCTION public.record_weightage_deduction(UUID, UUID, DATE, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_catalog_reward(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_kpi_award(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_kpi_award_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_catalog_redemption_status(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
