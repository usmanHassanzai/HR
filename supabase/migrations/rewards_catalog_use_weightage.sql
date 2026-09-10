-- Reward catalog uses monthly weightage (0–100%), not score points.

ALTER TABLE public.rewards_catalog
  ADD COLUMN IF NOT EXISTS weightage_required NUMERIC(5, 2);

UPDATE public.rewards_catalog
SET weightage_required = CASE
    WHEN COALESCE(point_cost, 0) >= 1000 THEN 90
    WHEN COALESCE(point_cost, 0) >= 500 THEN 80
    WHEN COALESCE(point_cost, 0) >= 250 THEN 70
    ELSE 80
END
WHERE weightage_required IS NULL;

ALTER TABLE public.rewards_catalog
  ALTER COLUMN weightage_required SET DEFAULT 80,
  ALTER COLUMN weightage_required SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rewards_catalog_weightage_required_check'
  ) THEN
    ALTER TABLE public.rewards_catalog
      ADD CONSTRAINT rewards_catalog_weightage_required_check
      CHECK (weightage_required >= 0 AND weightage_required <= 100);
  END IF;
END $$;

ALTER TABLE public.reward_redemptions
  ADD COLUMN IF NOT EXISTS weightage_at_claim NUMERIC(5, 2);

-- Keep point_cost populated for older rows/UI; new claims store 0 points.
ALTER TABLE public.reward_redemptions
  ALTER COLUMN points_used SET DEFAULT 0;

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
    v_weight NUMERIC;
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

    v_weight := public.kpi_award_month_score(v_uid, v_month);
    IF v_weight IS NULL THEN
        RAISE EXCEPTION 'No KPI weightage for this month yet';
    END IF;
    IF v_weight < COALESCE(v_item.weightage_required, 0) THEN
        RAISE EXCEPTION 'Need at least % weightage this month (you have %)',
            trim(to_char(v_item.weightage_required, 'FM999990.#######')) || '%',
            trim(to_char(v_weight, 'FM999990.#######')) || '%';
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

    SELECT r.id INTO v_existing
    FROM public.reward_redemptions r
    WHERE r.employee_id = v_uid
      AND r.reward_id = p_reward_id
      AND date_trunc('month', (timezone('Asia/Karachi', r.redeemed_at))::DATE) = v_month
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RAISE EXCEPTION 'You already redeemed this reward this month';
    END IF;

    INSERT INTO public.reward_redemptions (
        employee_id, reward_id, points_used, weightage_at_claim, status
    )
    VALUES (v_uid, p_reward_id, 0, v_weight, 'pending')
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_catalog_reward(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
