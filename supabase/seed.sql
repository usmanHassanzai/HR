-- Seed file for HR KPI Board
-- Enables pgcrypto for password hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Clean existing records (Optional, safe for clean slate)
TRUNCATE auth.users CASCADE;

-- 2. Insert test users into auth.users (Trigger will auto-populate public.users)
-- Passwords are: admin123, manager123, employee123
INSERT INTO auth.users (
    id,
    instance_id,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    recovery_token,
    email_change,
    email_change_token_new,
    raw_app_meta_data,
    raw_user_meta_data,
    aud,
    role,
    created_at,
    updated_at
) VALUES
-- Admin Profile (Sarah Jenkins)
(
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    '00000000-0000-0000-0000-000000000000',
    'admin@walfia.ai',
    crypt('admin123', gen_salt('bf')),
    now(),
    '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Sarah Jenkins","role":"admin"}',
    'authenticated',
    'authenticated',
    now(),
    now()
),
-- Manager Profile (Michael Scott)
(
    'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    '00000000-0000-0000-0000-000000000000',
    'manager@walfia.ai',
    crypt('manager123', gen_salt('bf')),
    now(),
    '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Michael Scott","role":"manager"}',
    'authenticated',
    'authenticated',
    now(),
    now()
),
-- Employee Profile (Jim Halpert)
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    '00000000-0000-0000-0000-000000000000',
    'employee@walfia.ai',
    crypt('employee123', gen_salt('bf')),
    now(),
    '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Jim Halpert","role":"employee"}',
    'authenticated',
    'authenticated',
    now(),
    now()
);

-- 2b. Create auth.identities (required for email/password login)
INSERT INTO auth.identities (
    provider_id,
    user_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
)
SELECT
    u.id,
    u.id,
    format('{"sub":"%s","email":"%s"}', u.id::text, u.email)::jsonb,
    'email',
    now(),
    now(),
    now()
FROM auth.users u
WHERE u.email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai');

-- 3. Update reporter hierarchy (Assign Michael Scott as Jim Halpert's Manager)
UPDATE public.users AS employee
SET manager_id = manager.id
FROM public.users AS manager
WHERE employee.email = 'employee@walfia.ai'
  AND manager.email = 'manager@walfia.ai';

-- 3b. Mark demo accounts as sandbox-only (isolated from production users)
UPDATE public.users SET is_demo = true
WHERE email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai');

-- 4. Seed KPI tasks for Jim Halpert (Employee) — manager-assigned style with dates
INSERT INTO public.kpis (id, user_id, name, description, target_value, current_value, direction, weight, category, department, start_date, end_date, completion_status, status)
VALUES
(
    '11111111-1111-1111-1111-111111111111',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Recruitment Cycle Time',
    'Average days from job posting to candidate offer acceptance.',
    100, 0, 'higher_better', 1.5, 'Talent Acquisition', 'Talent Acquisition',
    (CURRENT_DATE - INTERVAL '14 days')::DATE, (CURRENT_DATE + INTERVAL '16 days')::DATE,
    'pending', 'at_risk'
),
(
    '22222222-2222-2222-2222-222222222222',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Offer Acceptance Rate',
    'Percentage of extended job offers accepted by candidates.',
    100, 0, 'higher_better', 1.0, 'Talent Acquisition', 'Talent Acquisition',
    (CURRENT_DATE - INTERVAL '7 days')::DATE, (CURRENT_DATE + INTERVAL '23 days')::DATE,
    'pending', 'at_risk'
),
(
    '33333333-3333-3333-3333-333333333333',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Employee Satisfaction Score',
    'Average score out of 5 from quarterly internal surveys.',
    100, 100, 'higher_better', 2.0, 'Culture & Retention', 'Culture & Retention',
    (CURRENT_DATE - INTERVAL '30 days')::DATE, (CURRENT_DATE - INTERVAL '1 day')::DATE,
    'completed', 'on_track'
),
(
    '44444444-4444-4444-4444-444444444444',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Training Completion Rate',
    'Percentage of team completing mandatory corporate training programs.',
    100, 0, 'higher_better', 1.0, 'Development', 'Development',
    CURRENT_DATE, (CURRENT_DATE + INTERVAL '30 days')::DATE,
    'pending', 'at_risk'
),
(
    '55555555-5555-5555-5555-555555555555',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Absenteeism Rate',
    'Percentage of employee absences relative to scheduled work hours.',
    100, 0, 'lower_better', 1.2, 'Culture & Retention', 'Culture & Retention',
    (CURRENT_DATE - INTERVAL '10 days')::DATE, (CURRENT_DATE + INTERVAL '20 days')::DATE,
    'pending', 'on_track'
),
(
    '66666666-6666-6666-6666-666666666666',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Performance Review Completion',
    'Percentage of performance cycles fully completed on time.',
    100, 0, 'higher_better', 1.5, 'Performance Management', 'Performance Management',
    CURRENT_DATE, (CURRENT_DATE + INTERVAL '45 days')::DATE,
    'pending', 'at_risk'
),
(
    '77777777-7777-7777-7777-777777777777',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Turnover Rate',
    'Annualized employee attrition rate.',
    100, 0, 'lower_better', 2.0, 'Culture & Retention', 'Culture & Retention',
    (CURRENT_DATE - INTERVAL '5 days')::DATE, (CURRENT_DATE + INTERVAL '25 days')::DATE,
    'pending', 'off_track'
);

-- 5. Seed some initial Submissions history for Jim Halpert
INSERT INTO public.kpi_submissions (user_id, kpi_id, value, notes, created_at)
VALUES
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    '11111111-1111-1111-1111-111111111111',
    30.0,
    'Delayed background checks for new engineering roles.',
    now() - interval '7 days'
),
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    '11111111-1111-1111-1111-111111111111',
    28.0,
    'Cleared pipeline backlog; average time dropped.',
    now()
),
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    '33333333-3333-3333-3333-333333333333',
    4.5,
    'Feedback from post-onboarding survey is highly positive.',
    now()
);

-- 6. Seed Tasks for Jim Halpert
INSERT INTO public.tasks (user_id, title, description, status, due_date)
VALUES
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Review Q2 Survey Results',
    'Analyze raw satisfaction comments and categorize feedback items.',
    'pending'::task_status_type,
    now() + interval '3 days'
),
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Follow up on Engineering Openings',
    'Reach out to candidates with delayed recruitment cycle statuses.',
    'in_progress'::task_status_type,
    now() + interval '1 day'
),
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Submit Training Attendance Logs',
    'Upload spreadsheet of training completions for last week.',
    'done'::task_status_type,
    now() - interval '1 day'
);

-- 7. Seed Notifications for Jim Halpert
INSERT INTO public.notifications (user_id, title, message, type)
VALUES
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Recruitment Cycle Time Alert',
    'Your KPI "Recruitment Cycle Time" is currently Off Track at 28 days (Target: 25).',
    'alert'::notification_type
),
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'KPI Submission Reminder',
    'Please submit your weekly KPI values by Friday afternoon.',
    'reminder'::notification_type
);

-- 8. Phase 2: Initialize automation fields
-- Recalculate statuses from current values (INSERT does not fire before-update trigger)
UPDATE public.kpis SET current_value = current_value;

UPDATE public.kpis
SET
    off_track_since = CASE
        WHEN status = 'off_track'::kpi_status_type THEN now() - interval '8 days'
        ELSE NULL
    END,
    ai_narrative = public.generate_ai_narrative(name, direction, status, target_value, current_value, current_value),
    ai_narrative_updated_at = now(),
    suggested_target = public.generate_suggested_target(id)
WHERE user_id = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

UPDATE public.users
SET
    health_score = public.calculate_user_health_score(id),
    previous_health_score = public.calculate_user_health_score(id),
    health_score_updated_at = now()
WHERE id IN (
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'
);

-- Trigger escalation notification for Turnover Rate (off track 8+ days)
SELECT public.check_kpi_escalation('77777777-7777-7777-7777-777777777777');
