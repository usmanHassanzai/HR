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
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Jim Halpert","role":"employee"}',
    'authenticated',
    'authenticated',
    now(),
    now()
);

-- 3. Update reporter hierarchy (Assign Michael Scott as Jim Halpert's Manager)
UPDATE public.users
SET manager_id = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'
WHERE id = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

-- 4. Seed the 7 Standard KPIs for Jim Halpert (Employee)
INSERT INTO public.kpis (id, user_id, name, description, target_value, current_value, direction, weight, category)
VALUES
(
    '11111111-1111-1111-1111-111111111111',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Recruitment Cycle Time',
    'Average days from job posting to candidate offer acceptance.',
    25.0,
    28.0,
    'lower_better',
    1.5,
    'Talent Acquisition'
),
(
    '22222222-2222-2222-2222-222222222222',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Offer Acceptance Rate',
    'Percentage of extended job offers accepted by candidates.',
    85.0,
    80.0,
    'higher_better',
    1.0,
    'Talent Acquisition'
),
(
    '33333333-3333-3333-3333-333333333333',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Employee Satisfaction Score',
    'Average score out of 5 from quarterly internal surveys.',
    4.2,
    4.5,
    'higher_better',
    2.0,
    'Culture & Retention'
),
(
    '44444444-4444-4444-4444-444444444444',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Training Completion Rate',
    'Percentage of team completing mandatory corporate training programs.',
    95.0,
    90.0,
    'higher_better',
    1.0,
    'Development'
),
(
    '55555555-5555-5555-5555-555555555555',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Absenteeism Rate',
    'Percentage of employee absences relative to scheduled work hours.',
    3.0,
    2.5,
    'lower_better',
    1.2,
    'Culture & Retention'
),
(
    '66666666-6666-6666-6666-666666666666',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Performance Review Completion',
    'Percentage of performance cycles fully completed on time.',
    100.0,
    95.0,
    'higher_better',
    1.5,
    'Performance Management'
),
(
    '77777777-7777-7777-7777-777777777777',
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    'Turnover Rate',
    'Annualized employee attrition rate.',
    10.0,
    12.0,
    'lower_better',
    2.0,
    'Culture & Retention'
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
