-- Fix broken notifications UPDATE RLS (subquery WHERE id = id always matched every row
-- and caused mark-as-read to fail). Add reliable mark-read RPC.

DROP POLICY IF EXISTS "Users can mark own notifications as read" ON public.notifications;
CREATE POLICY "Users can mark own notifications as read"
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids UUID[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_count INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    UPDATE public.notifications
    SET is_read = true
    WHERE user_id = v_uid
      AND is_read = false;
  ELSE
    UPDATE public.notifications
    SET is_read = true
    WHERE user_id = v_uid
      AND is_read = false
      AND id = ANY (p_ids);
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_notifications_read(UUID[]) TO authenticated;
