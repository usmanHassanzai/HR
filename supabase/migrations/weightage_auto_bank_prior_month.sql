-- Auto-transfer unused closed-month weightage into Banked (by completed_at month).
-- Example: September earned 8% unused → October Saved for later / bank = 8%.

ALTER TABLE public.reward_weightage_bank_ledger
  DROP CONSTRAINT IF EXISTS reward_weightage_bank_ledger_source_kind_check;

ALTER TABLE public.reward_weightage_bank_ledger
  ADD CONSTRAINT reward_weightage_bank_ledger_source_kind_check
  CHECK (source_kind IN ('catalog', 'kpi_award', 'month_rollover'));

CREATE OR REPLACE FUNCTION public.stable_seed_uuid(p_seed TEXT)
RETURNS UUID
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (
    substr(h, 1, 8) || '-' ||
    substr(h, 9, 4) || '-' ||
    '5' || substr(h, 14, 3) || '-' ||
    lpad(to_hex((('x' || substr(h, 17, 2))::bit(8)::int & 63) | 128), 2, '0') || substr(h, 19, 2) || '-' ||
    substr(h, 21, 12)
  )::uuid
  FROM (SELECT md5(COALESCE(p_seed, '')) AS h) s;
$$;

/** Earned weightage for a month from completed KPIs (completed_at / end_date). */
CREATE OR REPLACE FUNCTION public.kpi_month_awarded_weightage(p_user_id UUID, p_month DATE)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc('month', p_month)::DATE;
    v_next DATE := (v_month + INTERVAL '1 month')::DATE;
    v_sum NUMERIC;
BEGIN
    SELECT LEAST(
        100,
        ROUND(COALESCE(SUM(
            LEAST(
                GREATEST(COALESCE(k.assigned_score, k.weight, 0), 0),
                GREATEST(COALESCE(k.weight, 0), 0)
            )
        ), 0), 2)
    )
    INTO v_sum
    FROM public.kpis k
    WHERE k.user_id = p_user_id
      AND k.completion_status = 'completed'
      AND date_trunc(
            'month',
            COALESCE(k.completed_at, k.end_date::timestamptz, k.created_at)
          )::DATE = v_month;

    -- Fallback: tasks overlapping the calendar month (legacy score path).
    IF COALESCE(v_sum, 0) <= 0 THEN
        v_sum := COALESCE(public.kpi_award_month_score(p_user_id, v_month), 0);
    END IF;

    RETURN ROUND(COALESCE(v_sum, 0), 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.rollover_unused_weightage_to_bank(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := p_user_id;
    v_company UUID;
    v_today DATE := (timezone('Asia/Karachi', now()))::DATE;
    v_current DATE := date_trunc('month', v_today)::DATE;
    v_cursor DATE;
    v_earned NUMERIC;
    v_out NUMERIC;
    v_left NUMERIC;
    v_source UUID;
    v_total NUMERIC := 0;
    v_i INTEGER;
    v_inserted INT;
BEGIN
    IF v_uid IS NULL THEN
        RETURN 0;
    END IF;

    SELECT company_id INTO v_company FROM public.users WHERE id = v_uid;
    IF v_company IS NULL THEN
        RETURN 0;
    END IF;

    FOR v_i IN 1..36 LOOP
        v_cursor := (v_current - make_interval(months => v_i))::DATE;
        v_earned := public.kpi_month_awarded_weightage(v_uid, v_cursor);
        IF v_earned IS NULL OR v_earned <= 0 THEN
            CONTINUE;
        END IF;

        v_out := COALESCE(public.get_weightage_deducted(v_uid, v_cursor), 0);
        v_left := GREATEST(0, ROUND(v_earned - v_out, 2));
        IF v_left <= 0 THEN
            CONTINUE;
        END IF;

        v_source := public.stable_seed_uuid(v_uid::text || '|month_rollover|' || v_cursor::text);

        IF EXISTS (
            SELECT 1
            FROM public.reward_weightage_bank_ledger b
            WHERE b.source_kind = 'month_rollover'
              AND b.source_id = v_source
              AND b.movement = 'deposit'
        ) THEN
            CONTINUE;
        END IF;

        INSERT INTO public.reward_weightage_ledger (
            employee_id, company_id, month, amount, source_kind, source_id, note, created_by
        )
        VALUES (
            v_uid,
            v_company,
            v_cursor,
            LEAST(v_left, 100),
            'bank_move',
            v_source,
            'Unused ' || to_char(v_cursor, 'Mon YYYY') || ' weightage rolled to bank',
            auth.uid()
        )
        ON CONFLICT (source_kind, source_id) DO NOTHING;

        GET DIAGNOSTICS v_inserted = ROW_COUNT;

        INSERT INTO public.reward_weightage_bank_ledger (
            employee_id, company_id, amount, movement, source_kind, source_id, note, created_by
        )
        VALUES (
            v_uid,
            v_company,
            LEAST(v_left, 100),
            'deposit',
            'month_rollover',
            v_source,
            'Unused ' || to_char(v_cursor, 'Mon YYYY') || ' weightage (never expires)',
            auth.uid()
        )
        ON CONFLICT (source_kind, source_id, movement) DO NOTHING;

        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted > 0 THEN
            v_total := v_total + LEAST(v_left, 100);
        END IF;
    END LOOP;

    RETURN ROUND(v_total, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_month_weightage_balance(p_user_id UUID DEFAULT NULL)
RETURNS TABLE (
    month DATE,
    earned NUMERIC,
    deducted NUMERIC,
    available NUMERIC,
    banked NUMERIC
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := COALESCE(p_user_id, auth.uid());
    v_today DATE := (timezone('Asia/Karachi', now()))::DATE;
    v_month DATE := date_trunc('month', v_today)::DATE;
    v_earned NUMERIC;
    v_gift_used NUMERIC;
    v_reserved NUMERIC;
    v_all_out NUMERIC;
    v_reveal BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Not allowed';
    END IF;

    -- Closed months (e.g. September) → Banked for next month redeem.
    PERFORM public.rollover_unused_weightage_to_bank(v_uid);

    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_gift_used := public.get_weightage_gift_used(v_uid, v_month);
    v_reserved := public.get_weightage_reserved(v_uid, v_month);
    v_all_out := public.get_weightage_deducted(v_uid, v_month);
    v_reveal := public.is_weightage_reveal_day();

    month := v_month;
    IF NOT v_reveal THEN
        earned := 0;
        deducted := 0;
        available := 0;
    ELSE
        earned := v_earned;
        deducted := CASE
            WHEN v_earned IS NULL THEN ROUND(COALESCE(v_gift_used, 0) + COALESCE(v_reserved, 0), 2)
            ELSE LEAST(
                ROUND(v_earned, 2),
                ROUND(COALESCE(v_gift_used, 0) + COALESCE(v_reserved, 0), 2)
            )
        END;
        available := CASE
            WHEN v_earned IS NULL THEN NULL
            ELSE GREATEST(0, ROUND(v_earned - COALESCE(v_all_out, 0) - COALESCE(v_reserved, 0), 2))
        END;
    END IF;
    banked := public.get_banked_weightage(v_uid);
    RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.stable_seed_uuid(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_month_awarded_weightage(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rollover_unused_weightage_to_bank(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_month_weightage_balance(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
