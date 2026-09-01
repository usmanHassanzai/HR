-- Assign office GPS to every employee and manager (personal sites + manager team sites).

CREATE OR REPLACE FUNCTION public.assign_office_to_all_employees(p_office_location_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_office public.office_locations%ROWTYPE;
    v_company UUID;
    v_count INTEGER := 0;
    r RECORD;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_caller) THEN
        RAISE EXCEPTION 'Only admins can assign office locations';
    END IF;
    IF p_office_location_id IS NULL THEN RAISE EXCEPTION 'Office is required'; END IF;

    IF public.is_demo_user(v_caller) THEN
        SELECT * INTO v_office FROM public.office_locations
        WHERE id = p_office_location_id AND is_demo = true;
        IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;

        FOR r IN
            SELECT id, role, is_demo FROM public.users
            WHERE role IN ('employee'::public.user_role, 'manager'::public.user_role)
              AND is_demo = true
        LOOP
            PERFORM public.assign_employee_work_site(
                r.id, p_office_location_id, v_office.name, v_office.address,
                v_office.latitude, v_office.longitude, v_office.radius_meters, true
            );
            IF r.role = 'manager'::public.user_role THEN
                PERFORM public.assign_manager_work_site(
                    r.id, p_office_location_id, v_office.name, v_office.address,
                    v_office.latitude, v_office.longitude, v_office.radius_meters, true
                );
            END IF;
            v_count := v_count + 1;
        END LOOP;
        RETURN v_count;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'No organization found'; END IF;

    SELECT * INTO v_office FROM public.office_locations
    WHERE id = p_office_location_id AND company_id = v_company;
    IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;

    FOR r IN
        SELECT id, role FROM public.users
        WHERE role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND company_id = v_company
          AND COALESCE(is_demo, false) = false
    LOOP
        PERFORM public.assign_employee_work_site(
            r.id, p_office_location_id, v_office.name, v_office.address,
            v_office.latitude, v_office.longitude, v_office.radius_meters, true
        );
        IF r.role = 'manager'::public.user_role THEN
            PERFORM public.assign_manager_work_site(
                r.id, p_office_location_id, v_office.name, v_office.address,
                v_office.latitude, v_office.longitude, v_office.radius_meters, true
            );
        END IF;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_office_to_all_employees(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
