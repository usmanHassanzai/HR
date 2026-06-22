-- Supabase Schema for HR KPI Board
-- Enforced via Row-Level Security (RLS)

-- 1. Create Enums and Types
CREATE TYPE user_role AS ENUM ('employee', 'manager', 'admin');
CREATE TYPE kpi_status_type AS ENUM ('on_track', 'at_risk', 'off_track');
CREATE TYPE task_status_type AS ENUM ('pending', 'in_progress', 'done');
CREATE TYPE kpi_completion_status AS ENUM ('pending', 'completed');

-- 2. Create Core Tables

-- Users table (extends auth.users)
CREATE TABLE public.users (
    id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT,
    role user_role DEFAULT 'employee'::user_role NOT NULL,
    manager_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    health_score NUMERIC DEFAULT 100 NOT NULL,
    previous_health_score NUMERIC DEFAULT 100 NOT NULL,
    health_score_updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- KPIs table (individual KPI settings and status)
CREATE TABLE public.kpis (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    target_value NUMERIC NOT NULL,
    current_value NUMERIC DEFAULT 0 NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('higher_better', 'lower_better')),
    status kpi_status_type DEFAULT 'on_track'::kpi_status_type NOT NULL,
    weight NUMERIC DEFAULT 1.0 NOT NULL CHECK (weight >= 0),
    category TEXT,
    department TEXT,
    start_date DATE,
    end_date DATE,
    completion_status kpi_completion_status DEFAULT 'pending'::kpi_completion_status NOT NULL,
    redo_count INTEGER DEFAULT 0 NOT NULL,
    overdue_notified_at TIMESTAMP WITH TIME ZONE,
    previous_value NUMERIC,
    off_track_since TIMESTAMP WITH TIME ZONE,
    ai_narrative TEXT,
    ai_narrative_updated_at TIMESTAMP WITH TIME ZONE,
    suggested_target NUMERIC,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- KPI Submissions table (submission history)
CREATE TABLE public.kpi_submissions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    kpi_id UUID REFERENCES public.kpis(id) ON DELETE CASCADE NOT NULL,
    value NUMERIC NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Tasks table
CREATE TABLE public.tasks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status task_status_type DEFAULT 'pending'::task_status_type NOT NULL,
    due_date TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Notifications table
CREATE TABLE public.notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type notification_type DEFAULT 'info'::notification_type NOT NULL,
    is_read BOOLEAN DEFAULT false NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Security Definer Helper Functions (To avoid infinite recursion in RLS policies)

CREATE OR REPLACE FUNCTION public.is_admin(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = user_id AND u.role = 'admin'::public.user_role
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.is_manager_of(p_manager_id UUID, p_employee_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = p_employee_id AND u.manager_id = p_manager_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- 4. KPI Status Calculation and Trigger Logic

CREATE OR REPLACE FUNCTION public.calculate_kpi_status(
    direction TEXT,
    target_value NUMERIC,
    current_value NUMERIC
) RETURNS kpi_status_type AS $$
DECLARE
    ratio NUMERIC;
BEGIN
    IF target_value = 0 THEN
        RETURN 'on_track'::kpi_status_type;
    END IF;

    IF direction = 'higher_better' THEN
        ratio := current_value / target_value;
        IF ratio >= 1.0 THEN
            RETURN 'on_track'::kpi_status_type;
        ELSIF ratio >= 0.85 THEN
            RETURN 'at_risk'::kpi_status_type;
        ELSE
            RETURN 'off_track'::kpi_status_type;
        END IF;
    ELSE -- lower_better
        ratio := current_value / target_value;
        IF ratio <= 1.0 THEN
            RETURN 'on_track'::kpi_status_type;
        ELSIF ratio <= 1.15 THEN
            RETURN 'at_risk'::kpi_status_type;
        ELSE
            RETURN 'off_track'::kpi_status_type;
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.on_kpi_update()
RETURNS TRIGGER AS $$
BEGIN
    new.status := public.calculate_kpi_status(new.direction, new.target_value, new.current_value);

    IF new.status = 'off_track'::kpi_status_type
       AND (old.status IS DISTINCT FROM 'off_track'::kpi_status_type) THEN
        new.off_track_since := timezone('utc'::text, now());
    ELSIF new.status <> 'off_track'::kpi_status_type THEN
        new.off_track_since := NULL;
    END IF;

    new.updated_at := timezone('utc'::text, now());
    RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kpi_before_update
    BEFORE UPDATE ON public.kpis
    FOR EACH ROW EXECUTE PROCEDURE public.on_kpi_update();

-- Phase 2: System notification helper (bypasses RLS for automation)
CREATE OR REPLACE FUNCTION public.create_system_notification(
    p_user_id UUID,
    p_title TEXT,
    p_message TEXT,
    p_type notification_type DEFAULT 'info'::notification_type
) RETURNS VOID AS $$
BEGIN
    INSERT INTO public.notifications (user_id, title, message, type)
    VALUES (p_user_id, p_title, p_message, p_type);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Phase 2: Weighted health score for a user
CREATE OR REPLACE FUNCTION public.calculate_user_health_score(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    total_points NUMERIC := 0;
    total_weight NUMERIC := 0;
    kpi_row RECORD;
    points NUMERIC;
BEGIN
    FOR kpi_row IN
        SELECT status, weight FROM public.kpis WHERE user_id = p_user_id
    LOOP
        IF kpi_row.status = 'on_track'::kpi_status_type THEN
            points := 100;
        ELSIF kpi_row.status = 'at_risk'::kpi_status_type THEN
            points := 50;
        ELSE
            points := 0;
        END IF;
        total_points := total_points + (points * kpi_row.weight);
        total_weight := total_weight + kpi_row.weight;
    END LOOP;

    IF total_weight = 0 THEN
        RETURN 100;
    END IF;

    RETURN ROUND(total_points / total_weight);
END;
$$ LANGUAGE plpgsql STABLE;

-- Phase 2: Rule-based AI narrative (generated once per submission)
CREATE OR REPLACE FUNCTION public.generate_ai_narrative(
    p_name TEXT,
    p_direction TEXT,
    p_status kpi_status_type,
    p_target NUMERIC,
    p_old_value NUMERIC,
    p_new_value NUMERIC
) RETURNS TEXT AS $$
DECLARE
    delta NUMERIC;
    pct NUMERIC;
BEGIN
    IF p_old_value IS NULL OR p_old_value = 0 THEN
        delta := 0;
        pct := 0;
    ELSE
        delta := p_new_value - p_old_value;
        pct := ROUND(ABS(delta / p_old_value * 100), 1);
    END IF;

    IF p_status = 'off_track'::kpi_status_type THEN
        RETURN format(
            '%s is Off Track at %s (target %s) — flagged for review.',
            p_name, p_new_value, p_target
        );
    END IF;

    IF p_status = 'at_risk'::kpi_status_type THEN
        RETURN format(
            '%s is At Risk at %s vs target %s — monitor closely this period.',
            p_name, p_new_value, p_target
        );
    END IF;

    IF p_direction = 'higher_better' AND delta > 0 THEN
        RETURN format('%s rose %.1f%% to %s — trending positively.', p_name, pct, p_new_value);
    ELSIF p_direction = 'lower_better' AND delta < 0 THEN
        RETURN format('%s dropped %.1f%% to %s — trending positively.', p_name, pct, p_new_value);
    ELSIF delta <> 0 THEN
        RETURN format('%s changed to %s (%.1f%% shift) — holding On Track.', p_name, p_new_value, pct);
    END IF;

    RETURN format('%s remains On Track at %s against target %s.', p_name, p_new_value, p_target);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Phase 2: Suggest next-month target from submission history
CREATE OR REPLACE FUNCTION public.generate_suggested_target(p_kpi_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    kpi_row RECORD;
    avg_value NUMERIC;
    suggested NUMERIC;
BEGIN
    SELECT direction, target_value INTO kpi_row
    FROM public.kpis WHERE id = p_kpi_id;

    SELECT AVG(value) INTO avg_value
    FROM (
        SELECT value FROM public.kpi_submissions
        WHERE kpi_id = p_kpi_id
        ORDER BY created_at DESC
        LIMIT 3
    ) recent;

    IF avg_value IS NULL THEN
        RETURN kpi_row.target_value;
    END IF;

    IF kpi_row.direction = 'higher_better' THEN
        suggested := GREATEST(avg_value * 1.05, kpi_row.target_value);
    ELSE
        suggested := LEAST(avg_value * 0.95, kpi_row.target_value);
    END IF;

    RETURN ROUND(suggested, 2);
END;
$$ LANGUAGE plpgsql STABLE;

-- Phase 2: Escalation check — notify manager + admin after 7 days off track
CREATE OR REPLACE FUNCTION public.check_kpi_escalation(p_kpi_id UUID)
RETURNS VOID AS $$
DECLARE
    kpi_row RECORD;
    manager_row RECORD;
    admin_row RECORD;
    days_off NUMERIC;
    escalation_msg TEXT;
BEGIN
    SELECT k.*, u.full_name AS employee_name, u.manager_id
    INTO kpi_row
    FROM public.kpis k
    JOIN public.users u ON u.id = k.user_id
    WHERE k.id = p_kpi_id;

    IF kpi_row.status <> 'off_track'::kpi_status_type
       OR kpi_row.off_track_since IS NULL THEN
        RETURN;
    END IF;

    days_off := EXTRACT(EPOCH FROM (timezone('utc'::text, now()) - kpi_row.off_track_since)) / 86400;

    IF days_off < 7 THEN
        RETURN;
    END IF;

    escalation_msg := format(
        'ESCALATION: %s has been Off Track for %s days (%s at %s vs target %s).',
        kpi_row.name,
        FLOOR(days_off)::TEXT,
        kpi_row.employee_name,
        kpi_row.current_value,
        kpi_row.target_value
    );

    -- Notify direct manager
    IF kpi_row.manager_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.notifications
            WHERE user_id = kpi_row.manager_id
              AND type = 'escalation'::notification_type
              AND message = escalation_msg
              AND created_at > timezone('utc'::text, now()) - interval '1 day'
        ) THEN
            PERFORM public.create_system_notification(
                kpi_row.manager_id,
                'KPI Escalation Alert',
                escalation_msg,
                'escalation'::notification_type
            );
        END IF;
    END IF;

    -- Notify senior manager (admin) as fallback
    FOR admin_row IN
        SELECT id FROM public.users WHERE role = 'admin'::user_role LIMIT 1
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM public.notifications
            WHERE user_id = admin_row.id
              AND type = 'escalation'::notification_type
              AND message = escalation_msg
              AND created_at > timezone('utc'::text, now()) - interval '1 day'
        ) THEN
            PERFORM public.create_system_notification(
                admin_row.id,
                'Senior KPI Escalation',
                escalation_msg,
                'escalation'::notification_type
            );
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Phase 2: Post-submission automation orchestrator
CREATE OR REPLACE FUNCTION public.run_submission_automation(
    p_kpi_id UUID,
    p_user_id UUID,
    p_old_value NUMERIC,
    p_new_value NUMERIC
) RETURNS VOID AS $$
DECLARE
    kpi_row RECORD;
    narrative TEXT;
    new_score NUMERIC;
    old_score NUMERIC;
    alert_msg TEXT;
BEGIN
    SELECT * INTO kpi_row FROM public.kpis WHERE id = p_kpi_id;

    narrative := public.generate_ai_narrative(
        kpi_row.name, kpi_row.direction, kpi_row.status,
        kpi_row.target_value, p_old_value, p_new_value
    );

    UPDATE public.kpis
    SET
        ai_narrative = narrative,
        ai_narrative_updated_at = timezone('utc'::text, now()),
        suggested_target = public.generate_suggested_target(p_kpi_id)
    WHERE id = p_kpi_id;

    -- Alert employee on off_track status
    IF kpi_row.status = 'off_track'::kpi_status_type THEN
        alert_msg := format(
            'Your KPI "%s" is now Off Track at %s (target %s).',
            kpi_row.name, p_new_value, kpi_row.target_value
        );
        PERFORM public.create_system_notification(
            p_user_id,
            'KPI Off Track Alert',
            alert_msg,
            'alert'::notification_type
        );

        -- Alert manager immediately
        IF EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND manager_id IS NOT NULL) THEN
            PERFORM public.create_system_notification(
                (SELECT manager_id FROM public.users WHERE id = p_user_id),
                'Team KPI Alert',
                format('Team member KPI "%s" went Off Track at %s.', kpi_row.name, p_new_value),
                'alert'::notification_type
            );
        END IF;
    END IF;

    -- Recalculate and persist health score
    SELECT health_score INTO old_score FROM public.users WHERE id = p_user_id;
    new_score := public.calculate_user_health_score(p_user_id);

    UPDATE public.users
    SET
        previous_health_score = old_score,
        health_score = new_score,
        health_score_updated_at = timezone('utc'::text, now())
    WHERE id = p_user_id;

    -- Check 7-day escalation
    PERFORM public.check_kpi_escalation(p_kpi_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Sync KPI submissions to current_value and run Phase 2 automation
CREATE OR REPLACE FUNCTION public.on_kpi_submission()
RETURNS TRIGGER AS $$
DECLARE
    old_value NUMERIC;
BEGIN
    SELECT current_value INTO old_value FROM public.kpis WHERE id = new.kpi_id;

    UPDATE public.kpis
    SET
        current_value = new.value,
        previous_value = old_value
    WHERE id = new.kpi_id;

    PERFORM public.run_submission_automation(new.kpi_id, new.user_id, old_value, new.value);

    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER kpi_submission_after_insert
    AFTER INSERT ON public.kpi_submissions
    FOR EACH ROW EXECUTE PROCEDURE public.on_kpi_submission();

-- 5. Automating auth.users profile sync trigger

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (id, email, full_name, role)
    VALUES (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'full_name', new.email),
        coalesce((new.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role)
    );
    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Helper trigger for updating tasks updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    new.updated_at := timezone('utc'::text, now());
    RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_before_update
    BEFORE UPDATE ON public.tasks
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- 6. Row-Level Security (RLS) Configuration

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Users RLS Policies
CREATE POLICY "Users view own profile, managers view team, admins view all"
    ON public.users FOR SELECT
    USING (
        auth.uid() = id
        OR public.is_manager_of(auth.uid(), id)
        OR public.is_admin(auth.uid())
    );

CREATE POLICY "Admins have full write access on users"
    ON public.users FOR ALL
    USING (public.is_admin(auth.uid()))
    WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Users can update their own name"
    ON public.users FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (
        auth.uid() = id
        AND role = (SELECT role FROM public.users WHERE id = auth.uid())
        AND manager_id IS NOT DISTINCT FROM (SELECT manager_id FROM public.users WHERE id = auth.uid())
    );

-- KPIs RLS Policies
CREATE POLICY "Users view own KPIs, managers view team KPIs, admins view all"
    ON public.kpis FOR SELECT
    USING (
        auth.uid() = user_id
        OR public.is_manager_of(auth.uid(), user_id)
        OR public.is_admin(auth.uid())
    );

CREATE POLICY "Admins can manage all KPIs"
    ON public.kpis FOR ALL
    USING (public.is_admin(auth.uid()))
    WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Managers can manage team KPIs"
    ON public.kpis FOR ALL
    USING (public.is_manager_of(auth.uid(), user_id))
    WITH CHECK (public.is_manager_of(auth.uid(), user_id));

-- KPI Submissions RLS Policies
CREATE POLICY "Users view own submissions, managers view team submissions, admins view all"
    ON public.kpi_submissions FOR SELECT
    USING (
        auth.uid() = user_id
        OR public.is_manager_of(auth.uid(), user_id)
        OR public.is_admin(auth.uid())
    );

CREATE POLICY "Employees/Managers can submit own values"
    ON public.kpi_submissions FOR INSERT
    WITH CHECK (
        auth.uid() = user_id
        AND EXISTS (
            SELECT 1 FROM public.kpis
            WHERE id = kpi_id AND user_id = auth.uid()
        )
    );

-- Tasks RLS Policies
CREATE POLICY "Users view own tasks, managers view team tasks, admins view all"
    ON public.tasks FOR SELECT
    USING (
        auth.uid() = user_id
        OR public.is_manager_of(auth.uid(), user_id)
        OR public.is_admin(auth.uid())
    );

CREATE POLICY "Users can update their own task status"
    ON public.tasks FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (
        auth.uid() = user_id
        AND title = (SELECT title FROM public.tasks WHERE id = id)
        AND description IS NOT DISTINCT FROM (SELECT description FROM public.tasks WHERE id = id)
    );

CREATE POLICY "Managers and admins can manage all tasks"
    ON public.tasks FOR ALL
    USING (
        public.is_admin(auth.uid())
        OR public.is_manager_of(auth.uid(), user_id)
    );

-- Notifications RLS Policies
CREATE POLICY "Users view own notifications"
    ON public.notifications FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can mark own notifications as read"
    ON public.notifications FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (
        auth.uid() = user_id
        AND title = (SELECT title FROM public.notifications WHERE id = id)
        AND message = (SELECT message FROM public.notifications WHERE id = id)
        AND type = (SELECT type FROM public.notifications WHERE id = id)
    );

CREATE POLICY "Admins and system can manage notifications"
    ON public.notifications FOR ALL
    USING (public.is_admin(auth.uid()));

-- Phase 2: Security definer RPCs for reliable admin/manager data access
CREATE OR REPLACE FUNCTION public.get_direct_reports(p_manager_id UUID)
RETURNS SETOF public.users AS $$
BEGIN
    IF auth.uid() IS DISTINCT FROM p_manager_id
       AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    RETURN QUERY
        SELECT u.* FROM public.users u
        WHERE u.manager_id = p_manager_id
        ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_all_users_admin()
RETURNS SETOF public.users AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    RETURN QUERY SELECT u.* FROM public.users u ORDER BY u.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Fully delete a user (admin only). Removes the auth.users row, which
-- cascades (ON DELETE CASCADE) to public.users and all related kpis,
-- tasks, submissions, and notifications.
CREATE OR REPLACE FUNCTION public.delete_user_admin(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: only admins can delete users';
    END IF;

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'You cannot delete your own account';
    END IF;

    DELETE FROM auth.users WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.get_direct_reports(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_users_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_admin(UUID) TO authenticated;

-- Admin-only password reset using pgcrypto bcrypt (same algorithm Supabase uses).
-- Allows an admin to set a new password for any user without the service-role key
-- being exposed on the frontend.
CREATE OR REPLACE FUNCTION public.reset_user_password_admin(p_user_id UUID, p_new_password TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: only admins can reset passwords';
    END IF;
    IF length(p_new_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters';
    END IF;
    UPDATE auth.users
    SET encrypted_password = crypt(p_new_password, gen_salt('bf'))
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

GRANT EXECUTE ON FUNCTION public.reset_user_password_admin(UUID, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 4: REWARDS & POINTS SYSTEM
-- ─────────────────────────────────────────────────────────────────────────────

-- Points ledger: one row per employee per month (points never expire)
CREATE TABLE IF NOT EXISTS public.points_ledger (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id  UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    month        DATE NOT NULL,  -- first day of the month, e.g. 2026-06-01
    kpi_score    NUMERIC NOT NULL,
    points_earned INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    UNIQUE (employee_id, month)
);

-- Reward catalog: admin-managed list of redeemable rewards
CREATE TABLE IF NOT EXISTS public.rewards_catalog (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    icon        TEXT DEFAULT '🎁',
    point_cost  INTEGER NOT NULL DEFAULT 1000,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Reward redemptions: tracks claims and fulfillment
CREATE TABLE IF NOT EXISTS public.reward_redemptions (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id  UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    reward_id    UUID REFERENCES public.rewards_catalog(id) ON DELETE RESTRICT NOT NULL,
    points_used  INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','fulfilled')),
    redeemed_at  TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Seed default catalog items (skip if already present)
INSERT INTO public.rewards_catalog (name, description, icon, point_cost) VALUES
  ('Team Dinner',           'Dinner for you and your team at a restaurant of your choice', '🍽️', 1000),
  ('Movie Tickets',         '2 cinema tickets + snacks',                                  '🎬', 1000),
  ('Half-Day Paid Leave',   'Take a half-day off, fully paid',                            '🌴', 1000),
  ('Gift Voucher ($50)',    '$50 gift voucher redeemable at major retailers',             '🎁', 1000)
ON CONFLICT DO NOTHING;

-- RLS
ALTER TABLE public.points_ledger       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rewards_catalog     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_redemptions  ENABLE ROW LEVEL SECURITY;

-- points_ledger: own rows; managers see direct reports; admin sees all
CREATE POLICY "points_ledger_select" ON public.points_ledger FOR SELECT
  USING (
    employee_id = auth.uid()
    OR public.is_admin(auth.uid())
    OR public.is_manager_of(auth.uid(), employee_id)
  );

CREATE POLICY "points_ledger_admin_all" ON public.points_ledger FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- rewards_catalog: everyone can read active items; only admin writes
CREATE POLICY "catalog_read" ON public.rewards_catalog FOR SELECT USING (true);
CREATE POLICY "catalog_admin" ON public.rewards_catalog FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- redemptions: employee own; manager team; admin all
CREATE POLICY "redemptions_select" ON public.reward_redemptions FOR SELECT
  USING (
    employee_id = auth.uid()
    OR public.is_admin(auth.uid())
    OR public.is_manager_of(auth.uid(), employee_id)
  );
CREATE POLICY "redemptions_insert" ON public.reward_redemptions FOR INSERT
  WITH CHECK (employee_id = auth.uid());
CREATE POLICY "redemptions_admin_update" ON public.reward_redemptions FOR UPDATE
  USING (public.is_admin(auth.uid()));
CREATE POLICY "redemptions_manager_update" ON public.reward_redemptions FOR UPDATE
  USING (public.is_manager_of(auth.uid(), employee_id));

-- ── Monthly points calculation function ──────────────────────────────────────
-- Called by pg_cron on the last day of each month (or can be run manually).
-- Tiered monthly bonus from weighted KPI score (points never expire):
--   >= 90% → 1000 pts | >= 80% → 500 pts | >= 70% → 250 pts | < 70% → 0
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

GRANT EXECUTE ON FUNCTION public.monthly_points_for_score(NUMERIC) TO authenticated;

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
        -- Weighted health score from KPIs
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

        -- Upsert: skip months already calculated
        INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
        VALUES (rec.id, p_month, v_score, v_points)
        ON CONFLICT (employee_id, month) DO NOTHING;

        -- Notify if points were awarded
        IF v_points > 0 THEN
            PERFORM public.create_system_notification(
                rec.id,
                'Monthly Bonus Awarded! 🎉',
                'You scored ' || round(v_score) || '% this month — +' || v_points || ' points added to your balance!',
                'info'
            );
        END IF;

        -- Check if total points crossed a 1000-point multiple → reward eligible
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

GRANT EXECUTE ON FUNCTION public.calculate_monthly_points(DATE) TO authenticated;

-- Points leaderboard (all employees + managers with KPIs)
CREATE OR REPLACE FUNCTION public.get_points_leaderboard()
RETURNS TABLE(full_name TEXT, total_points BIGINT) AS $$
  SELECT u.full_name, COALESCE(sum(pl.points_earned), 0)::BIGINT AS total_points
  FROM public.users u
  LEFT JOIN public.points_ledger pl ON pl.employee_id = u.id
  WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
  GROUP BY u.id, u.full_name
  ORDER BY total_points DESC;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_points_leaderboard() TO authenticated;

-- Notify manager when a direct report redeems a reward
CREATE OR REPLACE FUNCTION public.notify_manager_on_redemption()
RETURNS TRIGGER AS $$
DECLARE
    v_manager_id UUID;
    v_employee_name TEXT;
    v_reward_name TEXT;
BEGIN
    SELECT u.manager_id, u.full_name INTO v_manager_id, v_employee_name
    FROM public.users u WHERE u.id = NEW.employee_id;

    SELECT name INTO v_reward_name FROM public.rewards_catalog WHERE id = NEW.reward_id;

    IF v_manager_id IS NOT NULL THEN
        PERFORM public.create_system_notification(
            v_manager_id,
            'Team Reward Request 🎁',
            COALESCE(v_employee_name, 'An employee') || ' redeemed "' || COALESCE(v_reward_name, 'a reward') || '" — review in Team Rewards.',
            'info'
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS reward_redemption_notify_manager ON public.reward_redemptions;
CREATE TRIGGER reward_redemption_notify_manager
    AFTER INSERT ON public.reward_redemptions
    FOR EACH ROW EXECUTE FUNCTION public.notify_manager_on_redemption();

-- ── pg_cron: schedule on the last day of each month at 23:55 UTC ─────────────
-- Requires pg_cron extension (enabled in Supabase by default on paid plans).
-- The DO block skips gracefully if pg_cron is not available.
DO $outer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'monthly-kpi-points',
      '55 23 28-31 * *',
      'SELECT public.calculate_monthly_points()'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END;
$outer$;

-- ── KPI task assignment (manager → employee) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.assign_kpi_manager(
    p_employee_id UUID,
    p_department TEXT,
    p_description TEXT,
    p_start_date DATE,
    p_end_date DATE
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID) AS $$
DECLARE
    v_kpi_id UUID;
    v_email TEXT;
    v_name TEXT;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
    END IF;

    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;

    INSERT INTO public.kpis (
        user_id, name, description, department, category,
        start_date, end_date, target_value, current_value, weight, direction, status, completion_status, redo_count
    ) VALUES (
        p_employee_id, p_department, p_description, p_department, p_department,
        p_start_date, p_end_date, 100, 0, 1, 'higher_better', 'at_risk', 'pending', 0
    ) RETURNING id INTO v_kpi_id;

    PERFORM public.create_system_notification(
        p_employee_id,
        'New KPI Assigned',
        'Your manager assigned a KPI in ' || p_department || '. Due by ' || p_end_date::TEXT || '.',
        'info'
    );

    employee_email := v_email;
    employee_name := COALESCE(v_name, 'Employee');
    kpi_id := v_kpi_id;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.complete_kpi_employee(p_kpi_id UUID)
RETURNS TABLE(manager_email TEXT, manager_name TEXT, department TEXT) AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_mgr_email TEXT;
    v_mgr_name TEXT;
BEGIN
    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id AND user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'KPI not found'; END IF;
    IF v_kpi.completion_status = 'completed' THEN RAISE EXCEPTION 'Already completed'; END IF;

    UPDATE public.kpis SET
        completion_status = 'completed',
        status = 'on_track'::kpi_status_type,
        current_value = 100,
        updated_at = now()
    WHERE id = p_kpi_id;

    SELECT u.email, u.full_name INTO v_mgr_email, v_mgr_name
    FROM public.users emp
    JOIN public.users u ON u.id = emp.manager_id
    WHERE emp.id = auth.uid();

    IF (SELECT manager_id FROM public.users WHERE id = auth.uid()) IS NOT NULL THEN
        PERFORM public.create_system_notification(
            (SELECT manager_id FROM public.users WHERE id = auth.uid()),
            'KPI Completed',
            (SELECT full_name FROM public.users WHERE id = auth.uid()) || ' completed KPI: ' || COALESCE(v_kpi.department, v_kpi.name),
            'info'
        );
    END IF;

    manager_email := v_mgr_email;
    manager_name := COALESCE(v_mgr_name, 'Manager');
    department := COALESCE(v_kpi.department, v_kpi.name);
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_overdue_kpis()
RETURNS TABLE(emp_email TEXT, emp_name TEXT, department TEXT, end_date DATE, redo_count INTEGER) AS $$
DECLARE
    rec RECORD;
    v_month DATE := date_trunc('month', now())::DATE;
BEGIN
    FOR rec IN
        SELECT k.*, u.email AS e_email, u.full_name AS e_name
        FROM public.kpis k
        JOIN public.users u ON u.id = k.user_id
        WHERE k.completion_status = 'pending'
          AND k.end_date IS NOT NULL
          AND k.end_date < CURRENT_DATE
          AND (k.overdue_notified_at IS NULL OR k.overdue_notified_at::DATE < CURRENT_DATE)
    LOOP
        UPDATE public.kpis SET
            redo_count = redo_count + 1,
            status = 'off_track'::kpi_status_type,
            overdue_notified_at = now(),
            updated_at = now()
        WHERE id = rec.id;

        PERFORM public.create_system_notification(
            rec.user_id,
            'KPI Overdue',
            'Your KPI "' || COALESCE(rec.department, rec.name) || '" passed the deadline (' || rec.end_date::TEXT || '). Miss ' || (rec.redo_count + 1) || '/3.',
            'alert'
        );

        IF rec.redo_count + 1 >= 3 THEN
            INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
            VALUES (rec.user_id, v_month, 0, -300)
            ON CONFLICT (employee_id, month) DO UPDATE
            SET points_earned = public.points_ledger.points_earned - 300;

            PERFORM public.create_system_notification(
                rec.user_id,
                'Points Deducted',
                '3 missed KPI deadlines — 300 points deducted from your balance.',
                'escalation'
            );
        END IF;

        emp_email := rec.e_email;
        emp_name := COALESCE(rec.e_name, 'Employee');
        department := COALESCE(rec.department, rec.name);
        end_date := rec.end_date;
        redo_count := rec.redo_count + 1;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
-- Attendance & Leave module for Scorr
-- Run via: node scripts/attendance-leave-migration.mjs

DO $$ BEGIN
  CREATE TYPE public.attendance_status AS ENUM ('present', 'absent', 'late', 'half_day');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.leave_type AS ENUM ('annual', 'sick');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.leave_balances (
    user_id          UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    year             INTEGER NOT NULL,
    annual_allowance INTEGER NOT NULL DEFAULT 20,
    sick_allowance   INTEGER NOT NULL DEFAULT 10,
    annual_used      NUMERIC(5,1) NOT NULL DEFAULT 0,
    sick_used        NUMERIC(5,1) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, year)
);

CREATE TABLE IF NOT EXISTS public.attendance_records (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    attendance_date  DATE NOT NULL,
    status           public.attendance_status NOT NULL DEFAULT 'present',
    approval_status  public.approval_status NOT NULL DEFAULT 'pending',
    notes            TEXT,
    marked_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    UNIQUE (user_id, attendance_date)
);

CREATE TABLE IF NOT EXISTS public.leave_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    leave_type    public.leave_type NOT NULL,
    start_date    DATE NOT NULL,
    end_date      DATE NOT NULL,
    days_count    NUMERIC(5,1) NOT NULL,
    reason        TEXT,
    status        public.approval_status NOT NULL DEFAULT 'pending',
    reviewed_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ,
    review_notes  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON public.attendance_records(user_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON public.leave_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON public.leave_requests(status);

-- Weekday count (Mon–Fri) inclusive
CREATE OR REPLACE FUNCTION public.count_weekdays(p_start DATE, p_end DATE)
RETURNS NUMERIC AS $$
DECLARE
    d DATE := p_start;
    n NUMERIC := 0;
BEGIN
    IF p_end < p_start THEN RETURN 0; END IF;
    WHILE d <= p_end LOOP
        IF EXTRACT(ISODOW FROM d) < 6 THEN n := n + 1; END IF;
        d := d + 1;
    END LOOP;
    RETURN n;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.ensure_leave_balance(p_user_id UUID, p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER)
RETURNS VOID AS $$
DECLARE
    v_role public.user_role;
    v_annual INTEGER := 20;
    v_sick INTEGER := 10;
BEGIN
    SELECT role INTO v_role FROM public.users WHERE id = p_user_id;
    IF v_role IN ('manager'::public.user_role, 'admin'::public.user_role) THEN
        v_annual := 25;
        v_sick := 12;
    END IF;
    INSERT INTO public.leave_balances (user_id, year, annual_allowance, sick_allowance)
    VALUES (p_user_id, p_year, v_annual, v_sick)
    ON CONFLICT (user_id, year) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_leave_balance(p_user_id UUID DEFAULT auth.uid())
RETURNS TABLE(
    year INTEGER,
    annual_allowance INTEGER,
    annual_used NUMERIC,
    annual_remaining NUMERIC,
    sick_allowance INTEGER,
    sick_used NUMERIC,
    sick_remaining NUMERIC
) AS $$
DECLARE
    v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    PERFORM public.ensure_leave_balance(p_user_id, v_year);
    RETURN QUERY
    SELECT
        lb.year,
        lb.annual_allowance,
        lb.annual_used,
        GREATEST(lb.annual_allowance - lb.annual_used, 0)::NUMERIC AS annual_remaining,
        lb.sick_allowance,
        lb.sick_used,
        GREATEST(lb.sick_allowance - lb.sick_used, 0)::NUMERIC AS sick_remaining
    FROM public.leave_balances lb
    WHERE lb.user_id = p_user_id AND lb.year = v_year;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_my_attendance_summary(p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER)
RETURNS TABLE(
    total_records BIGINT,
    present_approved BIGINT,
    absent BIGINT,
    late BIGINT,
    pending BIGINT,
    attendance_rate NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT,
        COUNT(*) FILTER (WHERE ar.approval_status = 'approved' AND ar.status IN ('present', 'half_day', 'late'))::BIGINT,
        COUNT(*) FILTER (WHERE ar.status = 'absent' AND ar.approval_status = 'approved')::BIGINT,
        COUNT(*) FILTER (WHERE ar.status = 'late' AND ar.approval_status = 'approved')::BIGINT,
        COUNT(*) FILTER (WHERE ar.approval_status = 'pending')::BIGINT,
        CASE WHEN COUNT(*) FILTER (WHERE ar.approval_status = 'approved') = 0 THEN 100
             ELSE ROUND(
               100.0 * COUNT(*) FILTER (WHERE ar.approval_status = 'approved' AND ar.status IN ('present', 'late', 'half_day'))
               / NULLIF(COUNT(*) FILTER (WHERE ar.approval_status = 'approved'), 0), 1)
        END
    FROM public.attendance_records ar
    WHERE ar.user_id = auth.uid()
      AND EXTRACT(YEAR FROM ar.attendance_date) = p_year;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT CURRENT_DATE)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Cannot check in for a future date'; END IF;
    INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, marked_by)
    VALUES (auth.uid(), p_date, 'present', 'pending', auth.uid())
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present', approval_status = 'pending', marked_by = auth.uid(), reviewed_by = NULL, reviewed_at = NULL
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.mark_attendance(
    p_user_id UUID,
    p_date DATE,
    p_status public.attendance_status,
    p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_approval public.approval_status := 'pending';
    v_role public.user_role;
BEGIN
    SELECT role INTO v_role FROM public.users WHERE id = auth.uid();

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Use check-in for your own attendance';
    END IF;

    IF public.is_admin(auth.uid()) THEN
        v_approval := 'approved';
    ELSIF public.is_manager_of(auth.uid(), p_user_id) THEN
        v_approval := 'approved';
    ELSE
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, notes, marked_by, reviewed_by, reviewed_at)
    VALUES (p_user_id, p_date, p_status, v_approval, p_notes, auth.uid(),
            CASE WHEN v_approval = 'approved' THEN auth.uid() END,
            CASE WHEN v_approval = 'approved' THEN now() END)
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status,
        approval_status = EXCLUDED.approval_status,
        notes = EXCLUDED.notes,
        marked_by = auth.uid(),
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at
    RETURNING id INTO v_id;

    PERFORM public.create_system_notification(
        p_user_id,
        'Attendance Recorded',
        'Your attendance for ' || p_date::TEXT || ' was marked as ' || p_status::TEXT || '.',
        'info'::notification_type
    );
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.review_attendance(p_record_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    rec public.attendance_records%ROWTYPE;
    rec_role public.user_role;
BEGIN
    SELECT * INTO rec FROM public.attendance_records WHERE id = p_record_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Record not found'; END IF;

    SELECT role INTO rec_role FROM public.users WHERE id = rec.user_id;

    IF rec.user_id = auth.uid() AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Cannot approve your own attendance';
    END IF;

    IF rec_role = 'manager' AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Manager attendance must be approved by admin';
    END IF;

    IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_of(auth.uid(), rec.user_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    UPDATE public.attendance_records SET
        approval_status = CASE WHEN p_approve THEN 'approved'::public.approval_status ELSE 'rejected'::public.approval_status END,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        notes = COALESCE(p_notes, notes)
    WHERE id = p_record_id;

    PERFORM public.create_system_notification(
        rec.user_id,
        CASE WHEN p_approve THEN 'Attendance Approved' ELSE 'Attendance Rejected' END,
        'Your attendance for ' || rec.attendance_date::TEXT || ' was ' || CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_leave_type public.leave_type,
    p_start DATE,
    p_end DATE,
    p_reason TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_days NUMERIC;
    v_id UUID;
    v_year INTEGER := EXTRACT(YEAR FROM p_start)::INTEGER;
    v_bal public.leave_balances%ROWTYPE;
    v_mgr UUID;
BEGIN
    IF p_end < p_start THEN RAISE EXCEPTION 'End date must be on or after start date'; END IF;
    v_days := public.count_weekdays(p_start, p_end);
    IF v_days <= 0 THEN RAISE EXCEPTION 'Leave must include at least one weekday'; END IF;

    PERFORM public.ensure_leave_balance(auth.uid(), v_year);
    SELECT * INTO v_bal FROM public.leave_balances WHERE user_id = auth.uid() AND year = v_year FOR UPDATE;

    IF p_leave_type = 'annual' AND (v_bal.annual_allowance - v_bal.annual_used) < v_days THEN
        RAISE EXCEPTION 'Not enough annual leave (need %, have % remaining)', v_days, (v_bal.annual_allowance - v_bal.annual_used);
    END IF;
    IF p_leave_type = 'sick' AND (v_bal.sick_allowance - v_bal.sick_used) < v_days THEN
        RAISE EXCEPTION 'Not enough sick leave (need %, have % remaining)', v_days, (v_bal.sick_allowance - v_bal.sick_used);
    END IF;

    INSERT INTO public.leave_requests (user_id, leave_type, start_date, end_date, days_count, reason)
    VALUES (auth.uid(), p_leave_type, p_start, p_end, v_days, p_reason)
    RETURNING id INTO v_id;

    SELECT manager_id INTO v_mgr FROM public.users WHERE id = auth.uid();
    IF v_mgr IS NOT NULL THEN
        PERFORM public.create_system_notification(
            v_mgr,
            'Leave Request',
            (SELECT full_name FROM public.users WHERE id = auth.uid()) || ' requested ' || p_leave_type::TEXT || ' leave (' || v_days || ' days).',
            'info'::notification_type
        );
    END IF;
    -- Notify admins for manager leave requests
    IF EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'manager') THEN
        PERFORM public.create_system_notification(
            u.id,
            'Manager Leave Request',
            (SELECT full_name FROM public.users WHERE id = auth.uid()) || ' requested ' || p_leave_type::TEXT || ' leave.',
            'info'::notification_type
        )
        FROM public.users u WHERE u.role = 'admin';
    END IF;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.review_leave_request(p_request_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    req public.leave_requests%ROWTYPE;
    req_role public.user_role;
    v_year INTEGER;
BEGIN
    SELECT * INTO req FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
    IF req.status <> 'pending' THEN RAISE EXCEPTION 'Request already reviewed'; END IF;

    SELECT role INTO req_role FROM public.users WHERE id = req.user_id;

    IF req_role = 'manager' THEN
        IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Manager leave must be approved by admin'; END IF;
    ELSE
        IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_of(auth.uid(), req.user_id) THEN
            RAISE EXCEPTION 'Unauthorized';
        END IF;
    END IF;

    IF p_approve THEN
        v_year := EXTRACT(YEAR FROM req.start_date)::INTEGER;
        PERFORM public.ensure_leave_balance(req.user_id, v_year);
        IF req.leave_type = 'annual' THEN
            UPDATE public.leave_balances SET annual_used = annual_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        ELSE
            UPDATE public.leave_balances SET sick_used = sick_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        END IF;
        -- Mark attendance as on leave for weekdays in range
        INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, marked_by, reviewed_by, reviewed_at, notes)
        SELECT req.user_id, d::DATE, 'absent', 'approved', auth.uid(), auth.uid(), now(), 'Approved leave: ' || req.leave_type::TEXT
        FROM generate_series(req.start_date, req.end_date, '1 day'::interval) d
        WHERE EXTRACT(ISODOW FROM d) < 6
        ON CONFLICT (user_id, attendance_date) DO UPDATE
        SET status = 'absent', approval_status = 'approved', notes = EXCLUDED.notes, reviewed_by = auth.uid(), reviewed_at = now();
    END IF;

    UPDATE public.leave_requests SET
        status = CASE WHEN p_approve THEN 'approved'::public.approval_status ELSE 'rejected'::public.approval_status END,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = p_notes
    WHERE id = p_request_id;

    PERFORM public.create_system_notification(
        req.user_id,
        CASE WHEN p_approve THEN 'Leave Approved' ELSE 'Leave Rejected' END,
        'Your ' || req.leave_type::TEXT || ' leave (' || req.start_date::TEXT || ' to ' || req.end_date::TEXT || ') was ' ||
        CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- RLS
ALTER TABLE public.leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leave_balances_select ON public.leave_balances;
CREATE POLICY leave_balances_select ON public.leave_balances FOR SELECT
USING (user_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id));

DROP POLICY IF EXISTS attendance_select ON public.attendance_records;
CREATE POLICY attendance_select ON public.attendance_records FOR SELECT
USING (user_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id));

DROP POLICY IF EXISTS leave_requests_select ON public.leave_requests;
CREATE POLICY leave_requests_select ON public.leave_requests FOR SELECT
USING (
    user_id = auth.uid()
    OR public.is_admin(auth.uid())
    OR public.is_manager_of(auth.uid(), user_id)
);

GRANT EXECUTE ON FUNCTION public.get_leave_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_summary(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_attendance(UUID, DATE, public.attendance_status, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_attendance(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(public.leave_type, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_leave_request(UUID, BOOLEAN, TEXT) TO authenticated;

-- Seed leave balances for existing users
INSERT INTO public.leave_balances (user_id, year, annual_allowance, sick_allowance)
SELECT u.id, EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
       CASE WHEN u.role IN ('manager', 'admin') THEN 25 ELSE 20 END,
       CASE WHEN u.role IN ('manager', 'admin') THEN 12 ELSE 10 END
FROM public.users u
WHERE u.role IN ('employee', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Attendance KPI template for each active employee/manager (optional tracking KPI)
INSERT INTO public.kpis (user_id, name, description, target_value, current_value, direction, status, weight, category, department, completion_status)
SELECT u.id, 'Daily Attendance', 'Maintain approved daily attendance throughout the year', 100, 100, 'higher_better', 'on_track', 1.0, 'Attendance', 'HR', 'pending'
FROM public.users u
WHERE u.role IN ('employee', 'manager')
  AND NOT EXISTS (SELECT 1 FROM public.kpis k WHERE k.user_id = u.id AND k.category = 'Attendance');
-- Attendance & leave enhancements: email payload RPC, monthly summaries

DROP FUNCTION IF EXISTS public.submit_leave_request(public.leave_type, DATE, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_leave_type public.leave_type,
    p_start DATE,
    p_end DATE,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_days NUMERIC;
    v_id UUID;
    v_year INTEGER := EXTRACT(YEAR FROM p_start)::INTEGER;
    v_bal public.leave_balances%ROWTYPE;
    v_mgr UUID;
    v_mgr_email TEXT;
    v_mgr_name TEXT;
    v_emp_name TEXT;
    v_role public.user_role;
BEGIN
    IF p_end < p_start THEN RAISE EXCEPTION 'End date must be on or after start date'; END IF;
    v_days := public.count_weekdays(p_start, p_end);
    IF v_days <= 0 THEN RAISE EXCEPTION 'Leave must include at least one weekday'; END IF;

    PERFORM public.ensure_leave_balance(auth.uid(), v_year);
    SELECT * INTO v_bal FROM public.leave_balances WHERE user_id = auth.uid() AND year = v_year FOR UPDATE;

    IF p_leave_type = 'annual' AND (v_bal.annual_allowance - v_bal.annual_used) < v_days THEN
        RAISE EXCEPTION 'Not enough annual leave (need %, have % remaining)', v_days, (v_bal.annual_allowance - v_bal.annual_used);
    END IF;
    IF p_leave_type = 'sick' AND (v_bal.sick_allowance - v_bal.sick_used) < v_days THEN
        RAISE EXCEPTION 'Not enough sick leave (need %, have % remaining)', v_days, (v_bal.sick_allowance - v_bal.sick_used);
    END IF;

    SELECT full_name, role, manager_id INTO v_emp_name, v_role, v_mgr FROM public.users WHERE id = auth.uid();

    INSERT INTO public.leave_requests (user_id, leave_type, start_date, end_date, days_count, reason)
    VALUES (auth.uid(), p_leave_type, p_start, p_end, v_days, p_reason)
    RETURNING id INTO v_id;

    IF v_mgr IS NOT NULL THEN
        SELECT email, full_name INTO v_mgr_email, v_mgr_name FROM public.users WHERE id = v_mgr;
        PERFORM public.create_system_notification(
            v_mgr,
            'Leave Request',
            v_emp_name || ' requested ' || p_leave_type::TEXT || ' leave (' || v_days || ' days).',
            'info'::notification_type
        );
    END IF;

    IF v_role = 'manager' THEN
        PERFORM public.create_system_notification(
            u.id,
            'Manager Leave Request',
            v_emp_name || ' requested ' || p_leave_type::TEXT || ' leave.',
            'info'::notification_type
        )
        FROM public.users u WHERE u.role = 'admin';
    END IF;

    RETURN jsonb_build_object(
        'request_id', v_id,
        'employee_name', v_emp_name,
        'leave_type', p_leave_type,
        'start_date', p_start,
        'end_date', p_end,
        'days_count', v_days,
        'reason', p_reason,
        'requester_role', v_role,
        'manager_email', v_mgr_email,
        'manager_name', v_mgr_name,
        'admin_recipients', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('email', email, 'name', full_name)), '[]'::jsonb)
            FROM public.users WHERE role = 'admin'
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.submit_leave_request(public.leave_type, DATE, DATE, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_attendance_summary(
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
    p_month INTEGER DEFAULT NULL
)
RETURNS TABLE(
    total_records BIGINT,
    present_approved BIGINT,
    absent BIGINT,
    late BIGINT,
    pending BIGINT,
    attendance_rate NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT,
        COUNT(*) FILTER (WHERE ar.approval_status = 'approved' AND ar.status IN ('present', 'half_day', 'late'))::BIGINT,
        COUNT(*) FILTER (WHERE ar.status = 'absent' AND ar.approval_status = 'approved')::BIGINT,
        COUNT(*) FILTER (WHERE ar.status = 'late' AND ar.approval_status = 'approved')::BIGINT,
        COUNT(*) FILTER (WHERE ar.approval_status = 'pending')::BIGINT,
        CASE WHEN COUNT(*) FILTER (WHERE ar.approval_status = 'approved') = 0 THEN 100
             ELSE ROUND(
               100.0 * COUNT(*) FILTER (WHERE ar.approval_status = 'approved' AND ar.status IN ('present', 'late', 'half_day'))
               / NULLIF(COUNT(*) FILTER (WHERE ar.approval_status = 'approved'), 0), 1)
        END
    FROM public.attendance_records ar
    WHERE ar.user_id = auth.uid()
      AND EXTRACT(YEAR FROM ar.attendance_date) = p_year
      AND (p_month IS NULL OR EXTRACT(MONTH FROM ar.attendance_date) = p_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_attendance_summary(INTEGER, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_leave_summary(
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
    p_month INTEGER DEFAULT NULL
)
RETURNS TABLE(
    annual_days_taken NUMERIC,
    sick_days_taken NUMERIC,
    approved_requests BIGINT,
    pending_requests BIGINT,
    total_days_taken NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(lr.days_count) FILTER (WHERE lr.leave_type = 'annual' AND lr.status = 'approved'), 0)::NUMERIC,
        COALESCE(SUM(lr.days_count) FILTER (WHERE lr.leave_type = 'sick' AND lr.status = 'approved'), 0)::NUMERIC,
        COUNT(*) FILTER (WHERE lr.status = 'approved')::BIGINT,
        COUNT(*) FILTER (WHERE lr.status = 'pending')::BIGINT,
        COALESCE(SUM(lr.days_count) FILTER (WHERE lr.status = 'approved'), 0)::NUMERIC
    FROM public.leave_requests lr
    WHERE lr.user_id = auth.uid()
      AND EXTRACT(YEAR FROM lr.start_date) = p_year
      AND (p_month IS NULL OR EXTRACT(MONTH FROM lr.start_date) = p_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_leave_summary(INTEGER, INTEGER) TO authenticated;
