CREATE OR REPLACE FUNCTION public.update_user_auto_attendance(p_user_id uuid, p_auto_phone boolean DEFAULT NULL::boolean, p_auto_laptop boolean DEFAULT NULL::boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  IF v_me.id = p_user_id THEN
    NULL;
  ELSIF v_me.role IN ('admin', 'hr') AND v_me.company_id = v_target.company_id THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.users SET
    auto_phone_attendance = COALESCE(p_auto_phone, auto_phone_attendance),
    auto_laptop_attendance = COALESCE(p_auto_laptop, auto_laptop_attendance)
  WHERE id = p_user_id;
END;
$function$
