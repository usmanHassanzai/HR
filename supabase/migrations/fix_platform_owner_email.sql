-- Platform owner login is info@walfia.ai (not samiya@walfia.ai)

CREATE OR REPLACE FUNCTION public.platform_owner_email()
RETURNS TEXT AS $$
    SELECT 'info@walfia.ai'::TEXT;
$$ LANGUAGE sql STABLE;

UPDATE public.users
SET is_platform_owner = true
WHERE lower(email) = lower('info@walfia.ai');

UPDATE public.users
SET is_platform_owner = false
WHERE lower(email) = lower('samiya@walfia.ai');
