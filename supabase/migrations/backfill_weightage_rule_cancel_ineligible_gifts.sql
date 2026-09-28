-- Backfill: align historical KPI scores + cancel gifts that no longer qualify
-- under "earned cannot exceed each task's assigned weight".

-- 1) Cap every task's awarded score to its assigned weight.
UPDATE public.kpis
SET assigned_score = weight,
    updated_at = timezone('utc'::text, now())
WHERE weight IS NOT NULL
  AND (
    assigned_score IS NULL
    OR assigned_score > weight
  );

-- Prefer weight as the awarded score for already-approved tasks when score was missing.
UPDATE public.kpis
SET assigned_score = weight,
    updated_at = timezone('utc'::text, now())
WHERE completion_status = 'completed'
  AND weight IS NOT NULL
  AND (assigned_score IS NULL OR assigned_score <= 0);

-- 2) Cancel gifts/catalog that are no longer eligible after corrected earned weightage.
DO $$
DECLARE
    v_cfg public.kpi_award_config;
    v_q public.kpi_award_qualifications%ROWTYPE;
    v_red public.reward_redemptions%ROWTYPE;
    v_item public.rewards_catalog%ROWTYPE;
    v_month DATE;
    v_earned NUMERIC;
    v_cost NUMERIC;
    v_month_paid NUMERIC;
    v_bank_paid NUMERIC;
    v_refund NUMERIC;
    v_cancelled INT := 0;
BEGIN
    -- --- Company gifts (dinner / movie / surprise) ---
    FOR v_q IN
        SELECT *
        FROM public.kpi_award_qualifications
        WHERE status IS DISTINCT FROM 'dismissed'
          AND status IS DISTINCT FROM 'rejected'
        ORDER BY created_at ASC
    LOOP
        v_month := date_trunc('month', COALESCE(v_q.period_end, v_q.created_at::DATE))::DATE;
        v_earned := COALESCE(public.kpi_award_month_score(v_q.employee_id, v_month), 0);
        v_cfg := public.ensure_kpi_award_config(v_q.company_id);

        SELECT COALESCE(SUM(amount), 0) INTO v_month_paid
        FROM public.reward_weightage_ledger
        WHERE source_kind = 'kpi_award'
          AND source_id = v_q.id;

        SELECT COALESCE(SUM(amount), 0) INTO v_bank_paid
        FROM public.reward_weightage_bank_ledger
        WHERE source_kind = 'kpi_award'
          AND source_id = v_q.id
          AND movement = 'spend';

        IF v_q.rule_key = 'dinner_voucher' THEN
            v_cost := COALESCE(NULLIF(v_q.weightage_cost, 0), v_cfg.dinner_min_pct, 0);
            -- Eligible if corrected month earned covers the cost, or it was paid only from bank.
            IF v_month_paid > 0 AND v_earned + 0.05 < v_cost THEN
                UPDATE public.kpi_award_qualifications
                SET status = 'dismissed',
                    detail = trim(BOTH FROM COALESCE(detail || E'\n', '')
                        || 'Auto-cancelled: earned weightage after score correction ('
                        || trim(to_char(v_earned, 'FM999990.##'))
                        || '%) is below gift cost ('
                        || trim(to_char(v_cost, 'FM999990.##'))
                        || '%).'),
                    decided_at = timezone('utc'::text, now()),
                    decided_by = NULL
                WHERE id = v_q.id;

                v_refund := public.refund_weightage_deduction('kpi_award', v_q.id);
                v_cancelled := v_cancelled + 1;

                PERFORM public.create_system_notification(
                    v_q.employee_id,
                    'Gift cancelled after weightage correction',
                    'Your request for ' || COALESCE(v_q.reward_name, 'a gift')
                        || ' was cancelled because earned weightage was corrected to '
                        || trim(to_char(v_earned, 'FM999990.##'))
                        || '% (below the gift requirement).'
                        || CASE WHEN v_refund > 0 THEN
                            ' ' || trim(to_char(v_refund, 'FM999990.##')) || '% was returned.'
                          ELSE '' END,
                    'alert'
                );
            ELSIF v_month_paid <= 0 AND v_bank_paid <= 0 AND v_earned + 0.05 < v_cost THEN
                -- Open request with no payment yet, but would not qualify now.
                UPDATE public.kpi_award_qualifications
                SET status = 'dismissed',
                    detail = trim(BOTH FROM COALESCE(detail || E'\n', '')
                        || 'Auto-cancelled: not eligible after weightage correction.'),
                    decided_at = timezone('utc'::text, now()),
                    decided_by = NULL
                WHERE id = v_q.id;
                v_cancelled := v_cancelled + 1;
            END IF;

        ELSIF v_q.rule_key IN ('movie_tickets', 'surprise_gift') THEN
            -- Streak gifts cost 0; leave them unless already dismissed.
            NULL;
        END IF;
    END LOOP;

    -- --- Catalog redemptions ---
    FOR v_red IN
        SELECT *
        FROM public.reward_redemptions
        WHERE status IS DISTINCT FROM 'rejected'
        ORDER BY redeemed_at ASC
    LOOP
        SELECT * INTO v_item FROM public.rewards_catalog WHERE id = v_red.reward_id;
        v_month := date_trunc('month', (timezone('Asia/Karachi', COALESCE(v_red.redeemed_at, now())))::DATE)::DATE;
        v_earned := COALESCE(public.kpi_award_month_score(v_red.employee_id, v_month), 0);
        v_cost := COALESCE(NULLIF(v_red.weightage_cost, 0), v_item.weightage_required, 0);

        SELECT COALESCE(SUM(amount), 0) INTO v_month_paid
        FROM public.reward_weightage_ledger
        WHERE source_kind = 'catalog'
          AND source_id = v_red.id;

        SELECT COALESCE(SUM(amount), 0) INTO v_bank_paid
        FROM public.reward_weightage_bank_ledger
        WHERE source_kind = 'catalog'
          AND source_id = v_red.id
          AND movement = 'spend';

        IF COALESCE(v_cost, 0) <= 0 THEN
            CONTINUE;
        END IF;

        -- Not eligible if month payment exceeds corrected earned, or open claim cannot meet cost from earned and had no bank pay.
        IF (v_month_paid > 0 AND v_earned + 0.05 < v_cost)
           OR (v_month_paid <= 0 AND v_bank_paid <= 0 AND v_earned + 0.05 < v_cost)
           OR (v_month_paid > v_earned + 0.05) THEN
            UPDATE public.reward_redemptions
            SET status = 'rejected'
            WHERE id = v_red.id;

            v_refund := public.refund_weightage_deduction('catalog', v_red.id);
            v_cancelled := v_cancelled + 1;

            PERFORM public.create_system_notification(
                v_red.employee_id,
                'Catalog reward cancelled after weightage correction',
                'Your request for ' || COALESCE(v_item.name, 'a catalog reward')
                    || ' was cancelled because earned weightage was corrected to '
                    || trim(to_char(v_earned, 'FM999990.##'))
                    || '% (below the gift cost).'
                    || CASE WHEN v_refund > 0 THEN
                        ' ' || trim(to_char(v_refund, 'FM999990.##')) || '% was returned.'
                      ELSE '' END,
                'alert'
            );
        END IF;
    END LOOP;

    RAISE NOTICE 'Weightage backfill cancelled % ineligible gift(s)', v_cancelled;
END
$$;

-- 3) For each person/month, if remaining gift spend still exceeds corrected earned,
--    cancel newest gifts first until Used <= Earned.
DO $$
DECLARE
    grp RECORD;
    gift RECORD;
    v_earned NUMERIC;
    v_used NUMERIC;
    v_refund NUMERIC;
BEGIN
    FOR grp IN
        SELECT DISTINCT employee_id, month
        FROM public.reward_weightage_ledger
        WHERE source_kind IN ('catalog', 'kpi_award')
    LOOP
        v_earned := COALESCE(public.kpi_award_month_score(grp.employee_id, grp.month), 0);

        LOOP
            SELECT COALESCE(SUM(amount), 0) INTO v_used
            FROM public.reward_weightage_ledger
            WHERE employee_id = grp.employee_id
              AND month = grp.month
              AND source_kind IN ('catalog', 'kpi_award');

            EXIT WHEN v_used <= v_earned + 0.05;

            SELECT l.* INTO gift
            FROM public.reward_weightage_ledger l
            WHERE l.employee_id = grp.employee_id
              AND l.month = grp.month
              AND l.source_kind IN ('catalog', 'kpi_award')
            ORDER BY l.created_at DESC
            LIMIT 1;

            EXIT WHEN NOT FOUND;

            IF gift.source_kind = 'catalog' THEN
                UPDATE public.reward_redemptions
                SET status = 'rejected'
                WHERE id = gift.source_id
                  AND status IS DISTINCT FROM 'rejected';
            ELSE
                UPDATE public.kpi_award_qualifications
                SET status = 'dismissed',
                    detail = trim(BOTH FROM COALESCE(detail || E'\n', '')
                        || 'Auto-cancelled: used weightage exceeded corrected earned.'),
                    decided_at = timezone('utc'::text, now())
                WHERE id = gift.source_id
                  AND status IS DISTINCT FROM 'dismissed';
            END IF;

            v_refund := public.refund_weightage_deduction(gift.source_kind, gift.source_id);

            PERFORM public.create_system_notification(
                grp.employee_id,
                'Gift cancelled — weightage corrected',
                'A gift was cancelled because used weightage was higher than corrected earned weightage for '
                    || to_char(grp.month, 'Mon YYYY') || '.'
                    || CASE WHEN v_refund > 0 THEN
                        ' ' || trim(to_char(v_refund, 'FM999990.##')) || '% was returned.'
                      ELSE '' END,
                'alert'
            );
        END LOOP;
    END LOOP;
END
$$;

-- 4) Drop orphan bank_move rows whose gift source was already removed.
DELETE FROM public.reward_weightage_ledger l
WHERE l.source_kind = 'bank_move'
  AND NOT EXISTS (
      SELECT 1 FROM public.reward_weightage_ledger g
      WHERE g.source_id = l.source_id
        AND g.source_kind IN ('catalog', 'kpi_award')
  )
  AND NOT EXISTS (
      SELECT 1 FROM public.reward_weightage_bank_ledger b
      WHERE b.source_id = l.source_id
        AND b.source_kind IN ('catalog', 'kpi_award')
  );

NOTIFY pgrst, 'reload schema';
