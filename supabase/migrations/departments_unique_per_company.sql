-- Fix: department name/slug must be unique per company, not globally.
-- New orgs could not add "HR", "IT", etc. because older orgs / seed data
-- already used those names under departments_name_key.

ALTER TABLE public.departments DROP CONSTRAINT IF EXISTS departments_name_key;
ALTER TABLE public.departments DROP CONSTRAINT IF EXISTS departments_slug_key;

-- Also drop if they were created as indexes with these names
DROP INDEX IF EXISTS public.departments_name_key;
DROP INDEX IF EXISTS public.departments_slug_key;

-- One active department name per company (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS departments_company_name_unique
  ON public.departments (company_id, lower(trim(name)))
  WHERE company_id IS NOT NULL AND active = true;

-- Slugs unique per company (upsert_department already suffixes with company id)
CREATE UNIQUE INDEX IF NOT EXISTS departments_company_slug_unique
  ON public.departments (company_id, slug)
  WHERE company_id IS NOT NULL;

-- Demo / legacy rows without company_id: keep slug unique among themselves
CREATE UNIQUE INDEX IF NOT EXISTS departments_null_company_slug_unique
  ON public.departments (slug)
  WHERE company_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS departments_demo_name_unique
  ON public.departments (lower(trim(name)))
  WHERE company_id IS NULL AND is_demo = true AND active = true;

-- Friendlier create path if a race still hits the unique index
CREATE OR REPLACE FUNCTION public.create_department_admin(p_name TEXT)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_id UUID;
BEGIN
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only company admin can add departments';
    END IF;

    IF trim(p_name) = '' THEN
        RAISE EXCEPTION 'Department name is required';
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL AND NOT public.is_demo_user(v_uid) THEN
        RAISE EXCEPTION 'Account not linked to a company';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.departments d
        WHERE d.active = true
          AND lower(trim(d.name)) = lower(trim(p_name))
          AND (
              (v_company IS NOT NULL AND d.company_id = v_company)
              OR (public.is_demo_user(v_uid) AND d.is_demo = true AND d.company_id IS NULL)
          )
    ) THEN
        RAISE EXCEPTION 'A department with this name already exists';
    END IF;

    BEGIN
        -- New department always starts at 100% (other departments stay unchanged)
        v_id := public.upsert_department(trim(p_name), 100, NULL);
    EXCEPTION
        WHEN unique_violation THEN
            RAISE EXCEPTION 'A department with this name already exists';
    END;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.create_department_admin(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
