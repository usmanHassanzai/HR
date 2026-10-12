-- When company MFA trust policy is shortened or set to "always ask",
-- clamp or revoke existing trusted_devices so the UI setting is actually enforced.

CREATE OR REPLACE FUNCTION public.set_company_mfa_trust_policy(
  p_staff_days INTEGER,
  p_admin_days INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_revoked INTEGER := 0;
  v_clamped INTEGER := 0;
  v_batch INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF v_me.company_id IS NULL OR v_me.role NOT IN ('admin', 'hr') OR COALESCE(v_me.is_demo, false) THEN
    RAISE EXCEPTION 'Only company admin or HR can change MFA trust policy';
  END IF;
  IF p_staff_days NOT IN (0, 1, 7, 14, 30) THEN
    RAISE EXCEPTION 'Invalid staff trust days';
  END IF;
  IF p_admin_days NOT IN (0, 1, 7) THEN
    RAISE EXCEPTION 'Invalid admin/HR trust days';
  END IF;

  UPDATE public.companies
  SET
    mfa_trust_staff_days = p_staff_days,
    mfa_trust_admin_days = p_admin_days
  WHERE id = v_me.company_id;

  -- Staff/manager devices
  IF p_staff_days = 0 THEN
    UPDATE public.trusted_devices td
    SET revoked_at = timezone('utc'::text, now())
    FROM public.users u
    WHERE td.user_id = u.id
      AND u.company_id = v_me.company_id
      AND u.role NOT IN ('admin', 'hr')
      AND COALESCE(u.is_platform_owner, false) = false
      AND td.revoked_at IS NULL;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_revoked := v_revoked + v_batch;
  ELSE
    UPDATE public.trusted_devices td
    SET expires_at = LEAST(
      td.expires_at,
      td.created_at + make_interval(days => p_staff_days)
    )
    FROM public.users u
    WHERE td.user_id = u.id
      AND u.company_id = v_me.company_id
      AND u.role NOT IN ('admin', 'hr')
      AND COALESCE(u.is_platform_owner, false) = false
      AND td.revoked_at IS NULL
      AND td.expires_at > td.created_at + make_interval(days => p_staff_days);
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_clamped := v_clamped + v_batch;
  END IF;

  -- Admin/HR devices
  IF p_admin_days = 0 THEN
    UPDATE public.trusted_devices td
    SET revoked_at = timezone('utc'::text, now())
    FROM public.users u
    WHERE td.user_id = u.id
      AND u.company_id = v_me.company_id
      AND u.role IN ('admin', 'hr')
      AND COALESCE(u.is_platform_owner, false) = false
      AND td.revoked_at IS NULL;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_revoked := v_revoked + v_batch;
  ELSE
    UPDATE public.trusted_devices td
    SET expires_at = LEAST(
      td.expires_at,
      td.created_at + make_interval(days => p_admin_days)
    )
    FROM public.users u
    WHERE td.user_id = u.id
      AND u.company_id = v_me.company_id
      AND u.role IN ('admin', 'hr')
      AND COALESCE(u.is_platform_owner, false) = false
      AND td.revoked_at IS NULL
      AND td.expires_at > td.created_at + make_interval(days => p_admin_days);
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_clamped := v_clamped + v_batch;
  END IF;

  -- Drop session grants for users whose devices were fully revoked by always-ask
  IF p_staff_days = 0 OR p_admin_days = 0 THEN
    DELETE FROM public.mfa_session_grants g
    USING public.users u
    WHERE g.user_id = u.id
      AND u.company_id = v_me.company_id
      AND g.method = 'trusted_device'
      AND (
        (p_staff_days = 0 AND u.role NOT IN ('admin', 'hr'))
        OR (p_admin_days = 0 AND u.role IN ('admin', 'hr'))
      );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'mfa_trust_staff_days', p_staff_days,
    'mfa_trust_admin_days', p_admin_days,
    'revoked_devices', v_revoked,
    'clamped_devices', v_clamped
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_company_mfa_trust_policy(INTEGER, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
