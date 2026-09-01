-- Track whether the assignee has opened the task in Scorr (email alone is not a view).

ALTER TABLE public.kpis
    ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;

-- Do not backfill. Viewed is only set when the assignee opens the task in Scorr.

CREATE OR REPLACE FUNCTION public.mark_assigned_kpis_viewed(p_kpi_ids UUID[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    UPDATE public.kpis
    SET viewed_at = timezone('utc'::text, now())
    WHERE user_id = auth.uid()
      AND viewed_at IS NULL
      AND (p_kpi_ids IS NULL OR id = ANY(p_kpi_ids));

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_assigned_kpis_viewed(UUID[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
