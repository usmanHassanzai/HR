-- Enable RLS on shift tables only. Direct REST as anon/authenticated is restricted;
-- existing SECURITY DEFINER RPCs (upsert_work_shift, get_my_shift, etc.) still run
-- as the function owner and keep working.

ALTER TABLE public.work_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_shift_assignments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.work_shifts FROM anon, public;
REVOKE ALL ON TABLE public.employee_shift_assignments FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.work_shifts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.employee_shift_assignments TO authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.work_shifts FROM authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.employee_shift_assignments FROM authenticated;

DROP POLICY IF EXISTS work_shifts_select ON public.work_shifts;
DROP POLICY IF EXISTS work_shifts_write ON public.work_shifts;
DROP POLICY IF EXISTS work_shifts_update ON public.work_shifts;
DROP POLICY IF EXISTS work_shifts_delete ON public.work_shifts;

CREATE POLICY work_shifts_select ON public.work_shifts
  FOR SELECT TO authenticated
  USING (
    manager_id = auth.uid()
    OR public.can_access_user_data(manager_id)
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.manager_id = work_shifts.manager_id
        AND public.can_access_user_data(work_shifts.manager_id)
    )
  );

CREATE POLICY work_shifts_write ON public.work_shifts
  FOR INSERT TO authenticated
  WITH CHECK (
    manager_id = auth.uid()
    OR (public.is_admin(auth.uid()) AND public.can_access_user_data(manager_id))
  );

CREATE POLICY work_shifts_update ON public.work_shifts
  FOR UPDATE TO authenticated
  USING (
    manager_id = auth.uid()
    OR (public.is_admin(auth.uid()) AND public.can_access_user_data(manager_id))
  )
  WITH CHECK (
    manager_id = auth.uid()
    OR (public.is_admin(auth.uid()) AND public.can_access_user_data(manager_id))
  );

CREATE POLICY work_shifts_delete ON public.work_shifts
  FOR DELETE TO authenticated
  USING (
    manager_id = auth.uid()
    OR (public.is_admin(auth.uid()) AND public.can_access_user_data(manager_id))
  );

DROP POLICY IF EXISTS employee_shift_assignments_select ON public.employee_shift_assignments;
DROP POLICY IF EXISTS employee_shift_assignments_write ON public.employee_shift_assignments;
DROP POLICY IF EXISTS employee_shift_assignments_insert ON public.employee_shift_assignments;
DROP POLICY IF EXISTS employee_shift_assignments_update ON public.employee_shift_assignments;
DROP POLICY IF EXISTS employee_shift_assignments_delete ON public.employee_shift_assignments;

CREATE POLICY employee_shift_assignments_select ON public.employee_shift_assignments
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.can_access_user_data(user_id)
  );

CREATE POLICY employee_shift_assignments_insert ON public.employee_shift_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id)
  );

CREATE POLICY employee_shift_assignments_update ON public.employee_shift_assignments
  FOR UPDATE TO authenticated
  USING (
    public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id)
  )
  WITH CHECK (
    public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id)
  );

CREATE POLICY employee_shift_assignments_delete ON public.employee_shift_assignments
  FOR DELETE TO authenticated
  USING (
    public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id)
  );
