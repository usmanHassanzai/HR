/** Apply tiered monthly rewards SQL to live Supabase DB. */
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

const SQL = `
CREATE OR REPLACE FUNCTION public.monthly_points_for_score(p_score NUMERIC)
RETURNS INTEGER AS $$
BEGIN
    RETURN CASE
        WHEN p_score >= 90 THEN 1000
        WHEN p_score >= 80 THEN 500
        WHEN p_score >= 70 THEN 250
        ELSE 0
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.calculate_monthly_points(p_month DATE DEFAULT date_trunc('month', now())::DATE)
RETURNS TABLE(employee TEXT, score NUMERIC, points INTEGER) AS $$
DECLARE
    rec RECORD;
    v_score NUMERIC;
    v_points INTEGER;
    v_on  NUMERIC := 100;
    v_risk NUMERIC := 50;
    v_off  NUMERIC := 0;
BEGIN
    FOR rec IN
        SELECT u.id, u.email, u.full_name
        FROM public.users u
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
    LOOP
        SELECT CASE WHEN sum(k.weight) = 0 THEN 100
                    ELSE sum(
                      CASE k.status
                        WHEN 'on_track'  THEN v_on  * k.weight
                        WHEN 'at_risk'   THEN v_risk * k.weight
                        ELSE                  v_off  * k.weight
                      END
                    ) / sum(k.weight)
               END
        INTO v_score
        FROM public.kpis k
        WHERE k.user_id = rec.id;

        v_score  := COALESCE(v_score, 0);
        v_points := public.monthly_points_for_score(v_score);

        INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
        VALUES (rec.id, p_month, v_score, v_points)
        ON CONFLICT (employee_id, month) DO NOTHING;

        IF v_points > 0 THEN
            PERFORM public.create_system_notification(
                rec.id,
                'Monthly Bonus Awarded! 🎉',
                'You scored ' || round(v_score) || '% this month — +' || v_points || ' points added to your balance!',
                'info'
            );
        END IF;

        DECLARE
            v_total   INTEGER;
            v_prev    INTEGER;
        BEGIN
            SELECT COALESCE(sum(points_earned),0) INTO v_total
            FROM public.points_ledger WHERE employee_id = rec.id;

            SELECT COALESCE(sum(points_earned),0) INTO v_prev
            FROM public.points_ledger WHERE employee_id = rec.id AND month < p_month;

            IF floor(v_total::NUMERIC/1000) > floor(v_prev::NUMERIC/1000) THEN
                PERFORM public.create_system_notification(
                    rec.id,
                    'Reward Unlocked! 🏆',
                    'You''ve reached ' || v_total || ' points — you''ve earned a reward! Visit the Rewards tab to redeem.',
                    'alert'
                );
            END IF;
        END;

        employee := rec.full_name;
        score    := v_score;
        points   := v_points;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.monthly_points_for_score(NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_monthly_points(DATE) TO authenticated;
`;

async function sql(q) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 600));
  return body;
}

console.log('Applying tiered monthly rewards (90→1000, 80→500, 70→250)...');
await sql(SQL);
console.log('✅ Done. Points never expire — existing balances unchanged.');
