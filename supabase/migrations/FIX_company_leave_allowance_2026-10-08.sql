-- Office leave totals are set by admin or HR and saved on the company.
-- Everyone's current-year balance uses those amounts.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS annual_leave_days INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS sick_leave_days INTEGER NOT NULL DEFAULT 10;

CREATE OR REPLACE FUNCTION public.ensure_leave_balance(
  p_user_id UUID,
  p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_annual INTEGER := 20;
  v_sick INTEGER := 10;
BEGIN
  SELECT
    COALESCE(c.annual_leave_days, 20),
    COALESCE(c.sick_leave_days, 10)
  INTO v_annual, v_sick
  FROM public.users u
  LEFT JOIN public.companies c ON c.id = u.company_id
  WHERE u.id = p_user_id;

  v_annual := GREATEST(0, LEAST(COALESCE(v_annual, 20), 366));
  v_sick := GREATEST(0, LEAST(COALESCE(v_sick, 10), 366));

  INSERT INTO public.leave_balances (user_id, year, annual_allowance, sick_allowance)
  VALUES (p_user_id, p_year, v_annual, v_sick)
  ON CONFLICT (user_id, year) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_company_leave_policy()
RETURNS TABLE (
  annual_leave_days INTEGER,
  sick_leave_days INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT u.company_id INTO v_company FROM public.users u WHERE u.id = auth.uid();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company';
  END IF;

  RETURN QUERY
  SELECT c.annual_leave_days, c.sick_leave_days
  FROM public.companies c
  WHERE c.id = v_company;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_company_leave_policy(
  p_annual INTEGER,
  p_sick INTEGER
)
RETURNS TABLE (
  annual_leave_days INTEGER,
  sick_leave_days INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company UUID;
  v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
  v_annual INTEGER;
  v_sick INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_annual IS NULL OR p_sick IS NULL OR p_annual < 0 OR p_sick < 0 OR p_annual > 366 OR p_sick > 366 THEN
    RAISE EXCEPTION 'Enter annual and sick leave days between 0 and 366';
  END IF;

  v_annual := p_annual;
  v_sick := p_sick;

  SELECT u.company_id INTO v_company FROM public.users u WHERE u.id = auth.uid();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company';
  END IF;

  UPDATE public.companies
  SET annual_leave_days = v_annual,
      sick_leave_days = v_sick,
      updated_at = timezone('utc', now())
  WHERE id = v_company;

  UPDATE public.leave_balances lb
  SET annual_allowance = v_annual,
      sick_allowance = v_sick
  FROM public.users u
  WHERE u.id = lb.user_id
    AND u.company_id = v_company
    AND lb.year = v_year;

  INSERT INTO public.leave_balances (user_id, year, annual_allowance, sick_allowance)
  SELECT u.id, v_year, v_annual, v_sick
  FROM public.users u
  WHERE u.company_id = v_company
    AND COALESCE(u.is_demo, false) = false
    AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role, 'admin'::public.user_role)
    AND NOT EXISTS (
      SELECT 1 FROM public.leave_balances lb
      WHERE lb.user_id = u.id AND lb.year = v_year
    );

  RETURN QUERY
  SELECT c.annual_leave_days, c.sick_leave_days
  FROM public.companies c
  WHERE c.id = v_company;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_company_leave_policy() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_company_leave_policy(INTEGER, INTEGER) TO authenticated;
