-- Opening a task in Scorr starts In progress. Email / assignment does not.

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
    SET
        viewed_at = CASE
            WHEN viewed_by IS DISTINCT FROM auth.uid() THEN timezone('utc'::text, now())
            ELSE viewed_at
        END,
        viewed_by = auth.uid(),
        employee_progress = CASE
            WHEN COALESCE(employee_progress, '') = 'completed'
              OR completion_status = 'completed' THEN COALESCE(employee_progress, 'completed')
            ELSE 'started'
        END
    WHERE user_id = auth.uid()
      AND (p_kpi_ids IS NULL OR id = ANY(p_kpi_ids))
      AND (
        viewed_by IS DISTINCT FROM auth.uid()
        OR (
          COALESCE(employee_progress, '') NOT IN ('started', 'completed')
          AND completion_status IS DISTINCT FROM 'completed'
        )
      );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_assigned_kpis_viewed(UUID[]) TO authenticated;
