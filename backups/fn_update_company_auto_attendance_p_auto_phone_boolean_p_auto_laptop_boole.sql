CREATE OR REPLACE FUNCTION public.update_company_auto_attendance(p_auto_phone boolean DEFAULT NULL::boolean, p_auto_laptop boolean DEFAULT NULL::boolean, p_timezone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_timezone IS NOT NULL THEN
    PERFORM public.assert_valid_iana_timezone(p_timezone);
  END IF;

  UPDATE public.companies SET
    auto_phone_attendance = COALESCE(p_auto_phone, auto_phone_attendance),
    auto_laptop_attendance = COALESCE(p_auto_laptop, auto_laptop_attendance),
    timezone = COALESCE(p_timezone, timezone)
  WHERE id = v_me.company_id;

  RETURN (
    SELECT jsonb_build_object(
      'auto_phone_attendance', c.auto_phone_attendance,
      'auto_laptop_attendance', c.auto_laptop_attendance,
      'timezone', c.timezone
    )
    FROM public.companies c WHERE c.id = v_me.company_id
  );
END;
$function$
