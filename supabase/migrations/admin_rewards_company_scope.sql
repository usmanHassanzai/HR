-- Company admin rewards: exclude demo users; monthly job scoped to company.

CREATE OR REPLACE FUNCTION public.calculate_monthly_points(p_month DATE DEFAULT date_trunc('month', now())::DATE)
RETURNS TABLE(employee TEXT, score NUMERIC, points INTEGER) AS $$
DECLARE
    rec RECORD;
    v_score NUMERIC;
    v_points INTEGER;
    v_on  NUMERIC := 100;
    v_risk NUMERIC := 50;
    v_off  NUMERIC := 0;
    v_company UUID;
BEGIN
    IF public.is_demo_user(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Demo accounts cannot run the monthly points job';
    END IF;

    v_company := public.current_company_id();

    FOR rec IN
        SELECT u.id, u.email, u.full_name
        FROM public.users u
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND u.is_platform_owner = false
          AND (
              (public.is_demo_user(auth.uid()) AND u.is_demo = true)
              OR (
                  NOT public.is_demo_user(auth.uid())
                  AND u.is_demo = false
                  AND (v_company IS NULL OR u.company_id = v_company)
              )
          )
    LOOP
        SELECT CASE WHEN sum(k.weight) = 0 THEN 100
                    ELSE sum(CASE k.status WHEN 'on_track' THEN v_on * k.weight WHEN 'at_risk' THEN v_risk * k.weight ELSE v_off * k.weight END) / sum(k.weight)
               END INTO v_score FROM public.kpis k WHERE k.user_id = rec.id;
        v_score  := COALESCE(v_score, 0);
        v_points := public.monthly_points_for_score(v_score);
        INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
        VALUES (rec.id, p_month, v_score, v_points)
        ON CONFLICT (employee_id, month) DO NOTHING;
        IF v_points > 0 THEN
            PERFORM public.create_system_notification(rec.id, 'Monthly Points Awarded',
                'You earned ' || v_points || ' points this month (score: ' || round(v_score) || '%).', 'info');
        END IF;
        employee := COALESCE(rec.full_name, rec.email);
        score := v_score;
        points := v_points;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

NOTIFY pgrst, 'reload schema';
