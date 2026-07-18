import { Clock, Mail, Building2, Bell, Phone, CreditCard } from 'lucide-react';
import { Company, SUBSCRIPTION_PLANS } from '../utils/companyHelpers';

interface CompanyPendingScreenProps {
  company: Company;
  onLogout: () => void;
}

function planLabel(plan?: string | null) {
  return SUBSCRIPTION_PLANS.find((p) => p.id === plan)?.label ?? plan ?? '—';
}

export default function CompanyPendingScreen({ company, onLogout }: CompanyPendingScreenProps) {
  const isRejected = company.status === 'rejected';
  const isSuspended = company.status === 'suspended';

  return (
    <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh' }}>
      <div className="glass-panel" style={{ maxWidth: 580, padding: '2.5rem', textAlign: 'center' }}>
        <Building2 size={40} style={{ color: 'var(--accent-primary)', marginBottom: '1rem' }} />
        <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.5rem' }}>{company.name}</h2>

        {company.status === 'pending' && (
          <>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(251,191,36,0.15)', color: 'var(--color-warning)', padding: '0.35rem 0.75rem', borderRadius: 999, fontSize: '0.85rem', marginBottom: '1rem' }}>
              <Clock size={14} /> Awaiting admin approval
            </div>
            <div className="company-register__waiting-steps" style={{ listStyle: 'none', padding: '1rem 1.25rem', textAlign: 'left', margin: '1rem 0' }}>
              <p style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 0.75rem', fontWeight: 600, color: 'var(--color-warning)' }}>
                <Bell size={16} /> Please wait for admin approval
              </p>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
                Your registration has been received. The platform admin (<strong>Samiya Kayani</strong>) will review your organization details.
                You cannot use the system until approved — this page updates automatically when access is granted.
              </p>
            </div>
          </>
        )}

        {isRejected && (
          <p style={{ color: 'var(--color-danger)', lineHeight: 1.6, marginBottom: '1rem' }}>
            Your company registration was not approved. Contact support if you believe this is an error.
          </p>
        )}

        {isSuspended && (
          <p style={{ color: 'var(--color-danger)', lineHeight: 1.6, marginBottom: '1rem' }}>
            Your company account is suspended. Contact the platform owner for assistance.
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}>
            <Mail size={14} /> {company.contact_email}
          </span>
          {company.contact_phone && (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}>
              <Phone size={14} /> {company.contact_phone}
            </span>
          )}
          {company.subscription_plan && (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}>
              <CreditCard size={14} /> Plan: {planLabel(company.subscription_plan)}
            </span>
          )}
        </div>

        <button type="button" className="btn btn-secondary" style={{ marginTop: '1.5rem' }} onClick={onLogout}>
          Sign out
        </button>
      </div>
    </div>
  );
}
