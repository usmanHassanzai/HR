import { useState } from 'react';
import { supabase, supabaseSignup } from '../lib/supabase';
import {
  Building2, Loader2, Clock, AlertCircle, ArrowLeft, User, Mail, Phone, CreditCard,
} from 'lucide-react';
import {
  SUBSCRIPTION_PLANS,
  INDUSTRY_OPTIONS,
  EMPLOYEE_COUNT_OPTIONS,
  PLATFORM_OWNER_EMAIL,
  buildRegistrationEmailBody,
  type SubscriptionPlan,
  type CompanyRegistrationForm,
} from '../utils/companyHelpers';

interface CompanyRegisterProps {
  onBack: () => void;
  onRegistered: () => void;
  /** Render inside login card without extra outer spacing */
  embedded?: boolean;
}

const INITIAL: CompanyRegistrationForm = {
  companyName: '',
  industry: '',
  employeeCount: '',
  website: '',
  fullName: '',
  jobTitle: '',
  phone: '',
  email: '',
  password: '',
  confirmPassword: '',
  subscriptionPlan: 'trial',
  addressLine: '',
  city: '',
  country: '',
  notes: '',
};

export default function CompanyRegister({ onBack, onRegistered, embedded = false }: CompanyRegisterProps) {
  const [form, setForm] = useState<CompanyRegistrationForm>(INITIAL);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const set = <K extends keyof CompanyRegistrationForm>(key: K, value: CompanyRegistrationForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.companyName.trim()) return 'Company name is required.';
    if (!form.fullName.trim()) return 'Your full name is required.';
    if (!form.email.trim()) return 'Email is required.';
    if (!form.phone.trim()) return 'Phone number is required.';
    if (form.password.length < 6) return 'Password must be at least 6 characters.';
    if (form.password !== form.confirmPassword) return 'Passwords do not match.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const v = validate();
    if (v) {
      setError(v);
      return;
    }

    setLoading(true);
    try {
      const { error: signupError } = await supabaseSignup.auth.signUp({
        email: form.email.trim(),
        password: form.password,
        options: {
          data: {
            full_name: form.fullName.trim(),
            company_name: form.companyName.trim(),
            registration_type: 'company',
            phone: form.phone.trim(),
            job_title: form.jobTitle.trim(),
            industry: form.industry,
            employee_count: form.employeeCount,
            website: form.website.trim(),
            address_line: form.addressLine.trim(),
            city: form.city.trim(),
            country: form.country.trim(),
            subscription_plan: form.subscriptionPlan,
            notes: form.notes.trim(),
          },
        },
      });

      if (signupError) throw signupError;

      // Email alert to platform admin (Samiya)
      try {
        await supabase.functions.invoke('kpi_email', {
          body: {
            to: PLATFORM_OWNER_EMAIL,
            subject: `New company registration: ${form.companyName.trim()}`,
            body: buildRegistrationEmailBody(form),
          },
        });
      } catch {
        /* in-app notification still created in DB */
      }

      await supabaseSignup.auth.signOut();
      setSuccess(true);
      onRegistered();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className={`${embedded ? '' : 'glass-panel '}company-register company-register--success`} style={{ textAlign: 'center' }}>
        <Clock size={52} className="company-register__success-icon" />
        <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.75rem' }}>Please wait for admin approval</h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '0.5rem' }}>
          Your organization <strong>{form.companyName}</strong> has been registered successfully.
        </p>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1rem' }}>
          A notification was sent to the platform admin. You will receive an in-app alert when your account is approved.
        </p>
        <ul className="company-register__waiting-steps" style={{ listStyle: 'none', padding: 0 }}>
          <li>✓ Registration form submitted</li>
          <li>⏳ Admin review in progress (usually within 24 hours)</li>
          <li>○ Sign in after approval to set up managers & employees</li>
        </ul>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
          Registered email: <strong>{form.email}</strong>
        </p>
        <button type="button" className="btn btn-primary" onClick={onBack}>Back to sign in</button>
      </div>
    );
  }

  return (
    <div className={`${embedded ? '' : 'glass-panel '}company-register${embedded ? ' company-register--embedded' : ''}`}>
      {!embedded && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onBack} style={{ marginBottom: '1rem' }}>
          <ArrowLeft size={14} /> Back
        </button>
      )}

      <div className="company-register__head">
        <div className="company-register__head-icon">
          <Building2 size={22} />
        </div>
        <div>
          <h2 className="company-register__title">Register your organization</h2>
          <p className="company-register__intro">
            Start with a <strong>3-day free trial</strong>. Your application is reviewed before full access is granted.
          </p>
        </div>
      </div>

      {error && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: 'var(--color-danger)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <section className="company-register__section">
          <h3 className="company-register__section-title">Organization</h3>
          <div className="company-register__grid">
            <label className="company-register__field" style={{ gridColumn: '1 / -1' }}>
              <span>Company / organization name *</span>
              <input className="input-field" value={form.companyName} onChange={(e) => set('companyName', e.target.value)} placeholder="Acme Corporation" required />
            </label>
            <label className="company-register__field">
              <span>Industry</span>
              <select className="input-field" value={form.industry} onChange={(e) => set('industry', e.target.value)}>
                <option value="">Select industry</option>
                {INDUSTRY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <label className="company-register__field">
              <span>Number of employees</span>
              <select className="input-field" value={form.employeeCount} onChange={(e) => set('employeeCount', e.target.value)}>
                <option value="">Select range</option>
                {EMPLOYEE_COUNT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <label className="company-register__field" style={{ gridColumn: '1 / -1' }}>
              <span>Website</span>
              <input className="input-field" type="url" value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://yourcompany.com" />
            </label>
          </div>
        </section>

        <section className="company-register__section">
          <h3 className="company-register__section-title"><User size={14} style={{ verticalAlign: 'middle' }} /> Primary contact</h3>
          <div className="company-register__grid">
            <label className="company-register__field">
              <span>Full name *</span>
              <input className="input-field" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="Jane Doe" required />
            </label>
            <label className="company-register__field">
              <span>Job title</span>
              <input className="input-field" value={form.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} placeholder="HR Director" />
            </label>
            <label className="company-register__field">
              <span><Mail size={12} /> Work email *</span>
              <input className="input-field" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="admin@company.com" required />
            </label>
            <label className="company-register__field">
              <span><Phone size={12} /> Phone *</span>
              <input className="input-field" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+92 300 1234567" required />
            </label>
          </div>
        </section>

        <section className="company-register__section">
          <h3 className="company-register__section-title">Location (optional)</h3>
          <div className="company-register__grid">
            <label className="company-register__field" style={{ gridColumn: '1 / -1' }}>
              <span>Address</span>
              <input className="input-field" value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} placeholder="Street address" />
            </label>
            <label className="company-register__field">
              <span>City</span>
              <input className="input-field" value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Karachi" />
            </label>
            <label className="company-register__field">
              <span>Country</span>
              <input className="input-field" value={form.country} onChange={(e) => set('country', e.target.value)} placeholder="Pakistan" />
            </label>
          </div>
        </section>

        <section className="company-register__section">
          <h3 className="company-register__section-title"><CreditCard size={14} style={{ verticalAlign: 'middle' }} /> Subscription plan *</h3>
          <div className="company-register__plans">
            {SUBSCRIPTION_PLANS.map((plan) => (
              <button
                key={plan.id}
                type="button"
                className={`company-register__plan ${form.subscriptionPlan === plan.id ? 'company-register__plan--selected' : ''}`}
                onClick={() => set('subscriptionPlan', plan.id as SubscriptionPlan)}
              >
                <strong>{plan.label}</strong>
                <small>{plan.description}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="company-register__section">
          <h3 className="company-register__section-title">Account credentials</h3>
          <div className="company-register__grid">
            <label className="company-register__field">
              <span>Password *</span>
              <input className="input-field" type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="Min. 6 characters" required />
            </label>
            <label className="company-register__field">
              <span>Confirm password *</span>
              <input className="input-field" type="password" value={form.confirmPassword} onChange={(e) => set('confirmPassword', e.target.value)} placeholder="Repeat password" required />
            </label>
            <label className="company-register__field" style={{ gridColumn: '1 / -1' }}>
              <span>Additional notes (optional)</span>
              <textarea className="input-field" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Tell us about your HR goals or special requirements…" />
            </label>
          </div>
        </section>

        <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }} disabled={loading}>
          {loading ? <><Loader2 size={16} className="animate-spin" /> Submitting registration…</> : 'Submit registration — await admin approval'}
        </button>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.75rem' }}>
          By registering, you agree that your application will be reviewed by the Scorr platform admin before access is granted.
        </p>
      </form>
    </div>
  );
}
