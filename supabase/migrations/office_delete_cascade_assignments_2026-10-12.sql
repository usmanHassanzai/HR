-- Harden office / location deletes: clear assignment rows, then remove the entity.
-- employee_work_sites / manager_work_sites historically used ON DELETE SET NULL,
-- which left orphan rows with stale pin data. Prefer explicit cleanup.

CREATE OR REPLACE FUNCTION public.delete_office_location(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  v_ok BOOLEAN := false;
BEGIN
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can delete office locations';
  END IF;

  IF public.is_demo_user(v_uid) THEN
    SELECT EXISTS (
      SELECT 1 FROM public.office_locations WHERE id = p_id AND is_demo = true
    ) INTO v_ok;
  ELSE
    v_company := public.current_company_id();
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'Account not linked to a company';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.office_locations
      WHERE id = p_id AND company_id = v_company
    ) INTO v_ok;
  END IF;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'Office location not found';
  END IF;

  DELETE FROM public.employee_work_sites WHERE office_location_id = p_id;
  DELETE FROM public.manager_work_sites WHERE office_location_id = p_id;

  IF public.is_demo_user(v_uid) THEN
    DELETE FROM public.office_locations WHERE id = p_id AND is_demo = true;
  ELSE
    DELETE FROM public.office_locations WHERE id = p_id AND company_id = v_company;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_office_location(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_office(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  v_ok BOOLEAN := false;
  v_loc_ids UUID[];
BEGIN
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can delete offices';
  END IF;

  IF public.is_demo_user(v_uid) THEN
    SELECT EXISTS (
      SELECT 1 FROM public.offices WHERE id = p_id AND is_demo = true
    ) INTO v_ok;
  ELSE
    v_company := public.current_company_id();
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'Account not linked to a company';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.offices WHERE id = p_id AND company_id = v_company
    ) INTO v_ok;
  END IF;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'Office not found';
  END IF;

  SELECT COALESCE(array_agg(id), '{}')
  INTO v_loc_ids
  FROM public.office_locations
  WHERE office_id = p_id;

  IF cardinality(v_loc_ids) > 0 THEN
    DELETE FROM public.employee_work_sites WHERE office_location_id = ANY (v_loc_ids);
    DELETE FROM public.manager_work_sites WHERE office_location_id = ANY (v_loc_ids);
  END IF;

  -- Child pins cascade via office_locations.office_id ON DELETE CASCADE
  IF public.is_demo_user(v_uid) THEN
    DELETE FROM public.offices WHERE id = p_id AND is_demo = true;
  ELSE
    DELETE FROM public.offices WHERE id = p_id AND company_id = v_company;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_office(UUID) TO authenticated;
