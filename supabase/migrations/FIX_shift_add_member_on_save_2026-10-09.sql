-- Adding a person while editing a shift failed when anyone already had an
-- assignment that started today. Closing it with "yesterday" breaks
-- effective_to >= effective_from, and the whole save rolls back.
-- Close on the same day instead, and prefer the still-open row when both
-- cover today.

CREATE OR REPLACE FUNCTION public.shift_close_other_assignments(
  p_user_id UUID,
  p_shift_id UUID,
  p_effective_from DATE
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.employee_shift_assignments
  SET effective_to = GREATEST(effective_from, p_effective_from)
  WHERE user_id = p_user_id
    AND effective_to IS NULL
    AND shift_id IS DISTINCT FROM p_shift_id;
$$;

DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.admin_assign_shift(uuid,uuid[],date)'::regprocedure);
  def := replace(def,
$old$        UPDATE public.employee_shift_assignments
        SET effective_to = p_effective_from - 1
        WHERE user_id = v_target
          AND effective_to IS NULL
          AND shift_id IS DISTINCT FROM p_shift_id;
$old$,
$new$        PERFORM public.shift_close_other_assignments(v_target, p_shift_id, p_effective_from);
$new$);
  IF def NOT LIKE '%shift_close_other_assignments%' THEN
    RAISE EXCEPTION 'admin_assign_shift close patch did not apply';
  END IF;
  EXECUTE def;

  def := pg_get_functiondef('public.assign_shift_to_all_team(uuid,date)'::regprocedure);
  def := replace(def,
$old$        UPDATE public.employee_shift_assignments
        SET effective_to = p_effective_from - 1
        WHERE user_id = v_emp.id
          AND effective_to IS NULL
          AND shift_id <> p_shift_id;
$old$,
$new$        PERFORM public.shift_close_other_assignments(v_emp.id, p_shift_id, p_effective_from);
$new$);
  IF def NOT LIKE '%shift_close_other_assignments%' THEN
    RAISE EXCEPTION 'assign_shift_to_all_team close patch did not apply';
  END IF;
  EXECUTE def;

  def := pg_get_functiondef('public.get_org_shift_assignments()'::regprocedure);
  def := replace(def,
    'ORDER BY esa2.effective_from DESC',
    'ORDER BY (esa2.effective_to IS NULL) DESC, esa2.effective_from DESC');
  EXECUTE def;

  def := pg_get_functiondef('public.get_team_shift_assignments()'::regprocedure);
  def := replace(def,
    'ORDER BY esa2.effective_from DESC',
    'ORDER BY (esa2.effective_to IS NULL) DESC, esa2.effective_from DESC');
  EXECUTE def;

  def := pg_get_functiondef('public.get_active_shift_for_user(uuid,date)'::regprocedure);
  def := replace(def,
    'ORDER BY esa.effective_from DESC, esa.created_at DESC',
    'ORDER BY (esa.effective_to IS NULL) DESC, esa.effective_from DESC, esa.created_at DESC');
  EXECUTE def;
END $$;

GRANT EXECUTE ON FUNCTION public.shift_close_other_assignments(UUID, UUID, DATE) TO authenticated, service_role;
