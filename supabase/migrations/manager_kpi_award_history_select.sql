-- Allow managers to read KPI award history for their direct reports
-- (catalog redemptions already allow is_manager_of on reward_redemptions).

DROP POLICY IF EXISTS kpi_award_qual_select ON public.kpi_award_qualifications;
CREATE POLICY kpi_award_qual_select ON public.kpi_award_qualifications
  FOR SELECT TO authenticated
  USING (
    employee_id = auth.uid()
    OR (public.can_manage_org_shifts(auth.uid()) AND company_id = public.current_company_id())
    OR public.is_manager_of(auth.uid(), employee_id)
  );
