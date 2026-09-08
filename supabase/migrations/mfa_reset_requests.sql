-- Pending authenticator-reset requests (managers/admins who lost their TOTP app).

CREATE TABLE IF NOT EXISTS public.mfa_reset_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    requester_role TEXT,
    requester_name TEXT,
    requester_email TEXT,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS mfa_reset_requests_open_user
    ON public.mfa_reset_requests (user_id)
    WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mfa_reset_requests_company_open
    ON public.mfa_reset_requests (company_id, created_at DESC)
    WHERE resolved_at IS NULL;

ALTER TABLE public.mfa_reset_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_reset_requests_select ON public.mfa_reset_requests;
CREATE POLICY mfa_reset_requests_select ON public.mfa_reset_requests
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.is_platform_owner(auth.uid())
        OR (
            public.is_admin(auth.uid())
            AND company_id IS NOT DISTINCT FROM (
                SELECT u.company_id FROM public.users u WHERE u.id = auth.uid()
            )
        )
    );

REVOKE ALL ON public.mfa_reset_requests FROM anon, public;
GRANT SELECT ON public.mfa_reset_requests TO authenticated;

NOTIFY pgrst, 'reload schema';
