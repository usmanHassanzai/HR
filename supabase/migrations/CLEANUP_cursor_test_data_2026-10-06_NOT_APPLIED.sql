-- NOT APPLIED — await explicit "apply" for test-data cleanup.
-- Reason on every audit row: 'test data — Cursor verification 2026-10-06'
--
-- Affects:
--   akbarshah2225@gmail.com (NeuralTech) — check-in/out verification cycles
--   check@check.com (Test) — R73 forge edge tests (events_log + revoked devices only)
--
-- Does NOT touch Abdul or other open visits.

BEGIN;

-- Actor: platform owner (info@walfia.ai) for cross-company cleanup audit,
-- or use NeuralTech admin for akbar corrections via correct_attendance_times.
-- This script uses SECURITY DEFINER-style admin_correction write context + explicit audit.

DO $$
DECLARE
  v_actor UUID := (SELECT id FROM public.users WHERE email = 'info@walfia.ai' AND is_platform_owner LIMIT 1);
  v_akbar UUID := 'a5695f60-585d-4858-adf0-8a05a9f6ad0c';
  v_check UUID := 'e5e7db7c-7d32-49e3-90fa-18d00d247d7a';
  v_rec UUID := '0caaaa6d-0ab1-48ef-9784-4fa2cd5f8e2f';
  v_company UUID;
  v_before JSONB;
  v_after JSONB;
  v_visit UUID;
  v_reason TEXT := 'test data — Cursor verification 2026-10-06';
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'platform owner actor not found'; END IF;

  PERFORM public.attendance_set_write_context('admin_correction');

  -- 1) Akbar: delete zero-length visits created by verification cycles
  FOR v_visit IN
    SELECT id FROM public.attendance_visit_segments
    WHERE id IN (
      '08a3422c-47ac-4254-91b0-ad244669dab5',
      '222a55cc-98af-42a0-ba50-dde00d88e087'
    )
  LOOP
    SELECT company_id INTO v_company FROM public.users WHERE id = v_akbar;
    INSERT INTO public.attendance_corrections_audit (
      company_id, attendance_record_id, target_user_id, actor_user_id,
      reason, before, after, kind
    ) VALUES (
      v_company, v_rec, v_akbar, v_actor, v_reason,
      jsonb_build_object('deleted_visit_id', v_visit),
      jsonb_build_object('deleted', true),
      'test_cleanup_delete_visit'
    );
    DELETE FROM public.attendance_visit_segments WHERE id = v_visit;
  END LOOP;

  -- 2) Akbar: restore attendance_records clock_out to pre-test value
  SELECT * INTO v_before FROM (
    SELECT jsonb_build_object(
      'clock_in_at', clock_in_at, 'clock_out_at', clock_out_at,
      'work_minutes', work_minutes, 'attendance_source', attendance_source, 'notes', notes
    ) AS j FROM public.attendance_records WHERE id = v_rec
  ) s;

  UPDATE public.attendance_records SET
    clock_out_at = '2026-10-05 23:24:49.021348+00'::timestamptz,
    work_minutes = 0,
    notes = COALESCE(notes, '') || ' | ' || v_reason,
    attendance_source = 'admin_correction'
  WHERE id = v_rec
  RETURNING jsonb_build_object(
    'clock_in_at', clock_in_at, 'clock_out_at', clock_out_at,
    'work_minutes', work_minutes, 'attendance_source', attendance_source, 'notes', notes
  ) INTO v_after;

  SELECT company_id INTO v_company FROM public.users WHERE id = v_akbar;
  INSERT INTO public.attendance_corrections_audit (
    company_id, attendance_record_id, target_user_id, actor_user_id,
    reason, before, after, kind
  ) VALUES (
    v_company, v_rec, v_akbar, v_actor, v_reason, v_before, v_after, 'admin_correction'
  );

  -- 3) Forge events_log rows (check@check.com)
  SELECT company_id INTO v_company FROM public.users WHERE id = v_check;
  INSERT INTO public.attendance_corrections_audit (
    company_id, attendance_record_id, target_user_id, actor_user_id,
    reason, before, after, kind
  )
  SELECT v_company, NULL, v_check, v_actor, v_reason,
    jsonb_build_object('event_id', e.id, 'event', e.event, 'client_ip', e.client_ip, 'accepted', e.accepted, 'reason_code', e.reason_code),
    jsonb_build_object('deleted', true),
    'test_cleanup_delete_event'
  FROM public.attendance_events_log e
  WHERE e.id IN (
    'c6020629-6dd0-4609-8cd7-3829edd1b1e0',
    'c3645bf5-ea66-494d-8e3e-1334bb0a63a1',
    '09fc7769-2943-4034-9f83-909c8e6e3593',
    '5ec0e8b3-ce00-4093-995f-4a961b3193df'
  );

  DELETE FROM public.attendance_events_log
  WHERE id IN (
    'c6020629-6dd0-4609-8cd7-3829edd1b1e0',
    'c3645bf5-ea66-494d-8e3e-1334bb0a63a1',
    '09fc7769-2943-4034-9f83-909c8e6e3593',
    '5ec0e8b3-ce00-4093-995f-4a961b3193df'
  );

  -- 4) Revoked R73 devices (already revoked; delete rows after audit)
  INSERT INTO public.attendance_corrections_audit (
    company_id, attendance_record_id, target_user_id, actor_user_id,
    reason, before, after, kind
  )
  SELECT v_company, NULL, v_check, v_actor, v_reason,
    jsonb_build_object('device_row_id', d.id, 'device_id', d.device_id, 'revoked_at', d.revoked_at),
    jsonb_build_object('deleted', true),
    'test_cleanup_delete_device'
  FROM public.attendance_devices d
  WHERE d.id IN (
    '042f4833-168f-485a-8b4b-1dd2caa7288d',
    'd200561a-e054-477d-a123-2c027076193f'
  );

  DELETE FROM public.attendance_devices
  WHERE id IN (
    '042f4833-168f-485a-8b4b-1dd2caa7288d',
    'd200561a-e054-477d-a123-2c027076193f'
  );

  PERFORM public.attendance_set_write_context('normal');
END;
$$;

-- Review then COMMIT; or ROLLBACK.
-- COMMIT;
