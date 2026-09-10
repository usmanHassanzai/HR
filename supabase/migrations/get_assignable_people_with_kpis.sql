-- Fast roster of assignable people who already have at least one KPI.

CREATE OR REPLACE FUNCTION public.get_assignable_people_with_kpis()
RETURNS TABLE(user_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    RETURN QUERY
    SELECT DISTINCT k.user_id
    FROM public.kpis k
    WHERE public.can_assign_kpi_to(k.user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_assignable_people_with_kpis() TO authenticated;

NOTIFY pgrst, 'reload schema';
