-- UI sends status 'fulfilled' after Approve; older set_kpi_award_status only
-- accepted pending/approved/issued/dismissed and raised "Invalid status".
-- Map fulfilled → issued (canonical stored value) and pending_fulfillment → pending.

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

    UPDATE public.kpi_award_qualifications
    SET status = v_status, decided_at = timezone('utc'::text, now()), decided_by = auth.uid()
    WHERE id = p_id;

    IF v_status IN ('approved', 'issued') THEN
        PERFORM public.create_system_notification(
            v_row.employee_id,
            CASE WHEN v_status = 'issued' THEN 'Milestone fulfilled' ELSE 'Milestone approved' END,
            'Your reward: ' || v_row.reward_name,
            'info'
        );
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_kpi_award_status(UUID, TEXT) TO authenticated;
