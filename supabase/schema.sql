-- Supabase Schema for HR KPI Board
-- Enforced via Row-Level Security (RLS)

-- 1. Create Enums and Types
CREATE TYPE user_role AS ENUM ('employee', 'manager', 'admin');
CREATE TYPE kpi_status_type AS ENUM ('on_track', 'at_risk', 'off_track');
CREATE TYPE task_status_type AS ENUM ('pending', 'in_progress', 'done');
CREATE TYPE notification_type AS ENUM ('info', 'alert', 'reminder', 'escalation');

-- 2. Create Core Tables

-- Users table (extends auth.users)
CREATE TABLE public.users (
    id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT,
    role user_role DEFAULT 'employee'::user_role NOT NULL,
    manager_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
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
        SELECT 1 FROM public.users
        WHERE id = user_id AND role = 'admin'::user_role
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_manager_of(manager_id UUID, employee_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users
        WHERE id = employee_id AND public.users.manager_id = manager_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
    new.updated_at := timezone('utc'::text, now());
    RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kpi_before_update
    BEFORE UPDATE ON public.kpis
    FOR EACH ROW EXECUTE PROCEDURE public.on_kpi_update();

-- Sync KPI submissions to current_value on KPI card
CREATE OR REPLACE FUNCTION public.on_kpi_submission()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.kpis
    SET current_value = new.value
    WHERE id = new.kpi_id;
    RETURN new;
END;
$$ LANGUAGE plpgsql;

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
        coalesce((new.raw_user_meta_data->>'role')::user_role, 'employee'::user_role)
    );
    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
