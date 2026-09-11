-- Managers/admins can reject gift requests; refund weightage spent on redeem.

ALTER TABLE public.reward_redemptions
  DROP CONSTRAINT IF EXISTS reward_redemptions_status_check;

ALTER TABLE public.reward_redemptions
  ADD CONSTRAINT reward_redemptions_status_check
  CHECK (status IN ('pending', 'approved', 'fulfilled', 'rejected'));

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
    v_amount NUMERIC := 0;
BEGIN
    DELETE FROM public.reward_weightage_ledger
    WHERE source_kind = p_source_kind
      AND source_id = p_source_id
    RETURNING amount INTO v_amount;
    RETURN COALESCE(v_amount, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_weightage_deduction(TEXT, UUID) FROM PUBLIC, anon, authenticated;

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
                        || '% weightage was returned to your current balance.'
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
        -- Already deducted on redeem for monthly gifts; ON CONFLICT keeps this idempotent.
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
                        || '% weightage was returned to your current balance.'
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

-- Rejected catalog rows must not block a new monthly redeem.
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
          AND r.status IN ('pending', 'approved', 'fulfilled')
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

GRANT EXECUTE ON FUNCTION public.set_kpi_award_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_catalog_redemption_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_month_monthly_gift_claim(UUID, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
