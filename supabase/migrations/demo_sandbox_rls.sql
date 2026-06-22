-- RLS: demo accounts only see demo user data (not production users/KPIs/etc.)

CREATE OR REPLACE FUNCTION public.same_demo_scope(p_target_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF auth.uid() IS NULL THEN RETURN FALSE; END IF;
    IF p_target_user_id = auth.uid() THEN RETURN TRUE; END IF;
    IF NOT public.is_demo_user(auth.uid()) THEN RETURN TRUE; END IF;
    RETURN public.is_demo_user(p_target_user_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.same_demo_scope(UUID) TO authenticated;

-- users
DROP POLICY IF EXISTS "Users view own profile, managers view team, admins view all" ON public.users;
CREATE POLICY "Users view own profile, managers view team, admins view all"
    ON public.users FOR SELECT
    USING (
        auth.uid() = id
        OR (public.is_manager_of(auth.uid(), id) AND public.same_demo_scope(id))
        OR (public.is_admin(auth.uid()) AND public.same_demo_scope(id))
    );

DROP POLICY IF EXISTS "Admins have full write access on users" ON public.users;
CREATE POLICY "Admins have full write access on users"
    ON public.users FOR ALL
    USING (public.is_admin(auth.uid()) AND public.same_demo_scope(id))
    WITH CHECK (public.is_admin(auth.uid()) AND public.same_demo_scope(id));

-- kpis
DROP POLICY IF EXISTS "Users view own KPIs, managers view team KPIs, admins view all" ON public.kpis;
CREATE POLICY "Users view own KPIs, managers view team KPIs, admins view all"
    ON public.kpis FOR SELECT
    USING (
        auth.uid() = user_id
        OR (public.is_manager_of(auth.uid(), user_id) AND public.same_demo_scope(user_id))
        OR (public.is_admin(auth.uid()) AND public.same_demo_scope(user_id))
    );

DROP POLICY IF EXISTS "Admins can manage all KPIs" ON public.kpis;
CREATE POLICY "Admins can manage all KPIs"
    ON public.kpis FOR ALL
    USING (public.is_admin(auth.uid()) AND public.same_demo_scope(user_id))
    WITH CHECK (public.is_admin(auth.uid()) AND public.same_demo_scope(user_id));

DROP POLICY IF EXISTS "Managers can manage team KPIs" ON public.kpis;
CREATE POLICY "Managers can manage team KPIs"
    ON public.kpis FOR ALL
    USING (public.is_manager_of(auth.uid(), user_id) AND public.same_demo_scope(user_id))
    WITH CHECK (public.is_manager_of(auth.uid(), user_id) AND public.same_demo_scope(user_id));

-- kpi_submissions
DROP POLICY IF EXISTS "Users view own submissions, managers view team submissions, admins view all" ON public.kpi_submissions;
CREATE POLICY "Users view own submissions, managers view team submissions, admins view all"
    ON public.kpi_submissions FOR SELECT
    USING (
        auth.uid() = user_id
        OR (public.is_manager_of(auth.uid(), user_id) AND public.same_demo_scope(user_id))
        OR (public.is_admin(auth.uid()) AND public.same_demo_scope(user_id))
    );

DROP POLICY IF EXISTS "Employees/Managers can submit own values" ON public.kpi_submissions;
CREATE POLICY "Employees/Managers can submit own values"
    ON public.kpi_submissions FOR INSERT
    WITH CHECK (auth.uid() = user_id AND public.same_demo_scope(user_id));

-- tasks
DROP POLICY IF EXISTS "Users view own tasks, managers view team tasks, admins view all" ON public.tasks;
CREATE POLICY "Users view own tasks, managers view team tasks, admins view all"
    ON public.tasks FOR SELECT
    USING (
        auth.uid() = user_id
        OR (public.is_manager_of(auth.uid(), user_id) AND public.same_demo_scope(user_id))
        OR (public.is_admin(auth.uid()) AND public.same_demo_scope(user_id))
    );

DROP POLICY IF EXISTS "Managers and admins can manage all tasks" ON public.tasks;
CREATE POLICY "Managers and admins can manage all tasks"
    ON public.tasks FOR ALL
    USING (
        (public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id))
        AND public.same_demo_scope(user_id)
    )
    WITH CHECK (
        (public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id))
        AND public.same_demo_scope(user_id)
    );

-- points & redemptions
DROP POLICY IF EXISTS "points_ledger_select" ON public.points_ledger;
CREATE POLICY "points_ledger_select" ON public.points_ledger FOR SELECT
    USING (
        (employee_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), employee_id))
        AND public.same_demo_scope(employee_id)
    );

DROP POLICY IF EXISTS "points_ledger_admin_all" ON public.points_ledger;
CREATE POLICY "points_ledger_admin_all" ON public.points_ledger FOR ALL
    USING (public.is_admin(auth.uid()) AND public.same_demo_scope(employee_id))
    WITH CHECK (public.is_admin(auth.uid()) AND public.same_demo_scope(employee_id));

DROP POLICY IF EXISTS "redemptions_select" ON public.reward_redemptions;
CREATE POLICY "redemptions_select" ON public.reward_redemptions FOR SELECT
    USING (
        (employee_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), employee_id))
        AND public.same_demo_scope(employee_id)
    );

DROP POLICY IF EXISTS "redemptions_admin_update" ON public.reward_redemptions;
CREATE POLICY "redemptions_admin_update" ON public.reward_redemptions FOR UPDATE
    USING (public.is_admin(auth.uid()) AND public.same_demo_scope(employee_id));

DROP POLICY IF EXISTS "redemptions_manager_update" ON public.reward_redemptions;
CREATE POLICY "redemptions_manager_update" ON public.reward_redemptions FOR UPDATE
    USING (public.is_manager_of(auth.uid(), employee_id) AND public.same_demo_scope(employee_id));

-- attendance & leave
DROP POLICY IF EXISTS leave_balances_select ON public.leave_balances;
CREATE POLICY leave_balances_select ON public.leave_balances FOR SELECT
    USING (
        (user_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id))
        AND public.same_demo_scope(user_id)
    );

DROP POLICY IF EXISTS attendance_select ON public.attendance_records;
CREATE POLICY attendance_select ON public.attendance_records FOR SELECT
    USING (
        (user_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id))
        AND public.same_demo_scope(user_id)
    );

DROP POLICY IF EXISTS leave_requests_select ON public.leave_requests;
CREATE POLICY leave_requests_select ON public.leave_requests FOR SELECT
    USING (
        (user_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id))
        AND public.same_demo_scope(user_id)
    );
