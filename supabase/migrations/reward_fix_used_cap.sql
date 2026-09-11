-- Fix Used > Earned: only one monthly gift spend per person per month,
-- and never show Used above that month's earned weightage.

-- Cap month gift spends: keep one preferred ledger row (dinner/kpi first, else earliest);
-- drop extra same-month gift ledger rows that inflated Used past 100%.
DO $$
DECLARE
    grp RECORD;
    keeper RECORD;
    extra RECORD;
    v_earned NUMERIC;
    v_keep_amt NUMERIC;
    v_leftover NUMERIC;
BEGIN
    FOR grp IN
        SELECT employee_id, month
        FROM public.reward_weightage_ledger
        WHERE source_kind IN ('catalog', 'kpi_award')
        GROUP BY employee_id, month
        HAVING COUNT(*) > 1
            OR COALESCE(SUM(amount), 0) > 100
    LOOP
        v_earned := public.kpi_award_month_score(grp.employee_id, grp.month);
        IF v_earned IS NULL THEN
            v_earned := 100;
        END IF;

        SELECT l.* INTO keeper
        FROM public.reward_weightage_ledger l
        WHERE l.employee_id = grp.employee_id
          AND l.month = grp.month
          AND l.source_kind IN ('catalog', 'kpi_award')
        ORDER BY
            CASE WHEN l.source_kind = 'kpi_award' THEN 0 ELSE 1 END,
            l.created_at ASC
        LIMIT 1;

        IF NOT FOUND THEN
            CONTINUE;
        END IF;

        -- Remove other gift spends in the same month (one monthly gift only).
        FOR extra IN
            SELECT l.*
            FROM public.reward_weightage_ledger l
            WHERE l.employee_id = grp.employee_id
              AND l.month = grp.month
              AND l.source_kind IN ('catalog', 'kpi_award')
              AND l.id IS DISTINCT FROM keeper.id
        LOOP
            DELETE FROM public.reward_weightage_ledger
            WHERE source_id = extra.source_id
              AND source_kind IN (extra.source_kind, 'bank_move');
            DELETE FROM public.reward_weightage_bank_ledger
            WHERE source_id = extra.source_id
              AND source_kind = extra.source_kind;
        END LOOP;

        v_keep_amt := LEAST(ROUND(COALESCE(keeper.amount, 0), 2), ROUND(v_earned, 2));
        IF v_keep_amt <= 0 THEN
            DELETE FROM public.reward_weightage_ledger
            WHERE source_id = keeper.source_id
              AND source_kind IN (keeper.source_kind, 'bank_move');
            DELETE FROM public.reward_weightage_bank_ledger
            WHERE source_id = keeper.source_id
              AND source_kind = keeper.source_kind;
            CONTINUE;
        END IF;

        UPDATE public.reward_weightage_ledger
        SET amount = v_keep_amt,
            note = CASE
                WHEN amount IS DISTINCT FROM v_keep_amt THEN
                    COALESCE(note, '') || ' (capped to earned)'
                ELSE note
            END
        WHERE id = keeper.id;

        -- Align claim cost when present.
        IF keeper.source_kind = 'kpi_award' THEN
            UPDATE public.kpi_award_qualifications
            SET weightage_cost = v_keep_amt
            WHERE id = keeper.source_id;
        ELSIF keeper.source_kind = 'catalog' THEN
            UPDATE public.reward_redemptions
            SET weightage_cost = v_keep_amt
            WHERE id = keeper.source_id;
        END IF;

        v_leftover := ROUND(GREATEST(0, v_earned - v_keep_amt), 2);

        DELETE FROM public.reward_weightage_ledger
        WHERE source_kind = 'bank_move'
          AND source_id = keeper.source_id;
        DELETE FROM public.reward_weightage_bank_ledger
        WHERE source_kind = keeper.source_kind
          AND source_id = keeper.source_id
          AND movement = 'deposit';

        IF v_leftover > 0 THEN
            INSERT INTO public.reward_weightage_ledger (
                employee_id, company_id, month, amount, source_kind, source_id, note
            )
            VALUES (
                keeper.employee_id, keeper.company_id, keeper.month, v_leftover,
                'bank_move', keeper.source_id, 'Leftover after monthly gift (repair)'
            )
            ON CONFLICT (source_kind, source_id) DO UPDATE
            SET amount = EXCLUDED.amount,
                note = EXCLUDED.note;

            INSERT INTO public.reward_weightage_bank_ledger (
                employee_id, company_id, amount, movement, source_kind, source_id, note
            )
            VALUES (
                keeper.employee_id, keeper.company_id, v_leftover, 'deposit',
                keeper.source_kind, keeper.source_id, 'Leftover after monthly gift (repair)'
            )
            ON CONFLICT (source_kind, source_id, movement) DO UPDATE
            SET amount = EXCLUDED.amount,
                note = EXCLUDED.note;
        END IF;
    END LOOP;

    -- Also clamp single oversized gift rows (Used alone > earned).
    FOR keeper IN
        SELECT l.*, public.kpi_award_month_score(l.employee_id, l.month) AS earned_score
        FROM public.reward_weightage_ledger l
        WHERE l.source_kind IN ('catalog', 'kpi_award')
    LOOP
        v_earned := COALESCE(keeper.earned_score, 100);
        IF keeper.amount > v_earned THEN
            v_keep_amt := ROUND(v_earned, 2);
            UPDATE public.reward_weightage_ledger
            SET amount = v_keep_amt,
                note = COALESCE(note, '') || ' (capped to earned)'
            WHERE id = keeper.id;

            DELETE FROM public.reward_weightage_ledger
            WHERE source_kind = 'bank_move' AND source_id = keeper.source_id;
            DELETE FROM public.reward_weightage_bank_ledger
            WHERE source_kind = keeper.source_kind
              AND source_id = keeper.source_id
              AND movement = 'deposit';
        END IF;
    END LOOP;
END $$;

-- Never write a gift deduction larger than remaining available this month.
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
    v_month DATE := date_trunc('month', p_month)::DATE;
    v_amount NUMERIC := ROUND(GREATEST(0, LEAST(100, COALESCE(p_amount, 0))), 2);
    v_available NUMERIC;
BEGIN
    IF v_amount <= 0 THEN
        RETURN;
    END IF;
    IF p_source_kind IN ('catalog', 'kpi_award') THEN
        v_available := public.get_available_weightage(p_employee_id, v_month);
        IF v_available IS NULL THEN
            RETURN;
        END IF;
        v_amount := LEAST(v_amount, ROUND(GREATEST(0, v_available), 2));
        IF v_amount <= 0 THEN
            RETURN;
        END IF;
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

REVOKE ALL ON FUNCTION public.record_weightage_deduction(UUID, UUID, DATE, NUMERIC, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

-- Used is gift spend this month, never above earned.
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
    banked := public.get_banked_weightage(v_uid);
    RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_month_weightage_balance(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
