-- Platform owner login is usmankhan14700@gmail.com (replaces info@walfia.ai).

CREATE OR REPLACE FUNCTION public.platform_owner_email()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT 'usmankhan14700@gmail.com'::TEXT;
$$;

UPDATE public.users
SET is_platform_owner = true
WHERE lower(email) = lower(public.platform_owner_email());

UPDATE public.users
SET is_platform_owner = false
WHERE lower(email) = lower('info@walfia.ai')
  AND lower(email) IS DISTINCT FROM lower(public.platform_owner_email());
