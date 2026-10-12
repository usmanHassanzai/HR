CREATE OR REPLACE FUNCTION public.get_my_attendance_schedule()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN public.attendance_schedule_for_user(auth.uid(), timezone('utc', now()), 7);
END;
$function$
