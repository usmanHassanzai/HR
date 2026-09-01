UPDATE public.kpi_assignment_edits e
SET
    editor_name = COALESCE(e.editor_name, u.full_name),
    editor_role = COALESCE(
        e.editor_role,
        CASE WHEN u.role = 'admin' THEN 'Admin' ELSE 'Manager' END
    )
FROM public.users u
WHERE e.editor_id = u.id
  AND (e.editor_name IS NULL OR e.editor_role IS NULL);

UPDATE public.kpis k
SET
    last_edited_by_name = e.editor_name,
    last_edited_by_role = e.editor_role,
    last_edited_at = e.created_at
FROM (
    SELECT DISTINCT ON (kpi_id)
        kpi_id,
        editor_name,
        editor_role,
        created_at
    FROM public.kpi_assignment_edits
    ORDER BY kpi_id, created_at DESC
) e
WHERE k.id = e.kpi_id
  AND k.last_edited_at IS NULL;
