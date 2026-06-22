-- Ensure the 3 sandbox demo accounts exist and are configured correctly
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create auth users if missing (fixed UUIDs from seed)
INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    confirmation_token, recovery_token, email_change, email_change_token_new,
    raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at
) VALUES
(
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    '00000000-0000-0000-0000-000000000000',
    'admin@walfia.ai',
    crypt('admin123', gen_salt('bf')),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Sarah Jenkins","role":"admin"}',
    'authenticated', 'authenticated', now(), now()
),
(
    'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    '00000000-0000-0000-0000-000000000000',
    'manager@walfia.ai',
    crypt('manager123', gen_salt('bf')),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Michael Scott","role":"manager"}',
    'authenticated', 'authenticated', now(), now()
),
(
    'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    '00000000-0000-0000-0000-000000000000',
    'employee@walfia.ai',
    crypt('employee123', gen_salt('bf')),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Jim Halpert","role":"employee"}',
    'authenticated', 'authenticated', now(), now()
)
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    encrypted_password = EXCLUDED.encrypted_password,
    email_confirmed_at = COALESCE(auth.users.email_confirmed_at, now()),
    raw_user_meta_data = EXCLUDED.raw_user_meta_data,
    updated_at = now();

-- identities for email login
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT u.id, u.id, format('{"sub":"%s","email":"%s"}', u.id::text, u.email)::jsonb, 'email', now(), now(), now()
FROM auth.users u
WHERE u.email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai')
ON CONFLICT DO NOTHING;

-- public profiles (trigger may have created them; ensure roles + demo flag)
INSERT INTO public.users (id, email, full_name, role, is_demo)
SELECT a.id, a.email,
       COALESCE(a.raw_user_meta_data->>'full_name', a.email),
       COALESCE((a.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role),
       true
FROM auth.users a
WHERE a.email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai')
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    is_demo = true;

UPDATE public.users SET is_demo = true
WHERE email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai');

UPDATE public.users AS e SET manager_id = m.id
FROM public.users AS m
WHERE e.email = 'employee@walfia.ai' AND m.email = 'manager@walfia.ai';

SELECT email, role, is_demo FROM public.users
WHERE email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai')
ORDER BY email;
