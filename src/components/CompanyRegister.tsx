import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  Building2, Loader2, AlertCircle, ArrowLeft, ArrowRight, Mail, Phone, CheckCircle2,
} from 'lucide-react';
import {
  INDUSTRY_OPTIONS,
  EMPLOYEE_COUNT_OPTIONS,
  notifyPlatformOwnerOfRegistration,
  type CompanyRegistrationForm,
} from '../utils/companyHelpers';
import { sendSignupOtp, verifySignupOtp } from '../utils/signupOtp';
import PasswordField from './PasswordField';
import '../styles/company-register.css';

interface CompanyRegisterProps {
  onBack: () => void;
  onRegistered: () => void;
  onSession?: (session: unknown) => void;
  embedded?: boolean;
}

const INITIAL: CompanyRegistrationForm = {
  companyName: '',
  industry: '',
  employeeCount: '',
  fullName: '',
  phone: '',
  email: '',
  password: '',
  confirmPassword: '',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function Hint({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <em className="company-register__hint company-register__hint--err">{error}</em>;
  if (ok) return <em className="company-register__hint company-register__hint--ok">{ok}</em>;
  return null;
}

export default function CompanyRegister({ onBack, onSession, embedded = false }: CompanyRegisterProps) {
  const [form, setForm] = useState<CompanyRegistrationForm>(INITIAL);
  const [step, setStep] = useState<1 | 2>(1);
  const [touched, setTouched] = useState<Partial<Record<keyof CompanyRegistrationForm, boolean>>>({});
  const [industrySelect, setIndustrySelect] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'form' | 'verify'>('form');
  const [otp, setOtp] = useState('');
  const [otpHint, setOtpHint] = useState('');

  const set = <K extends keyof CompanyRegistrationForm>(key: K, value: CompanyRegistrationForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const blur = (key: keyof CompanyRegistrationForm) => {
    setTouched((prev) => ({ ...prev, [key]: true }));
  };

  const presetIndustries = INDUSTRY_OPTIONS.filter((o) => o !== 'Other');
  const industryIsOther = industrySelect === 'Other';

  const fieldErrors = useMemo(() => {
    const e: Partial<Record<keyof CompanyRegistrationForm, string>> = {};
    if (form.companyName.trim().length > 0 && form.companyName.trim().length < 2) {
      e.companyName = 'Enter the full company name.';
    }
    if (form.fullName.trim().length > 0 && form.fullName.trim().length < 2) {
      e.fullName = 'Enter your name.';
    }
    if (form.email.trim()) {
      if (!EMAIL_RE.test(form.email.trim())) e.email = 'Enter a valid work email.';
    }
    if (form.phone.trim() && phoneDigits(form.phone).length < 7) {
      e.phone = 'Enter a valid phone number.';
    }
    if (form.password) {
      if (form.password.length < 6) e.password = 'Use at least 6 characters.';
    }
    if (form.confirmPassword && form.confirmPassword !== form.password) {
      e.confirmPassword = 'Passwords do not match.';
    }
    if (industryIsOther && industrySelect === 'Other' && !form.industry.trim() && touched.industry) {
      e.industry = 'Type your industry, or pick one from the list.';
    }
    return e;
  }, [form, industryIsOther, industrySelect, touched.industry]);

  const show = (key: keyof CompanyRegistrationForm) => (touched[key] ? fieldErrors[key] : undefined);

  const step1Ready =
    form.companyName.trim().length >= 2
    && form.fullName.trim().length >= 2
    && EMAIL_RE.test(form.email.trim())
    && phoneDigits(form.phone).length >= 7
    && form.password.length >= 6
    && form.password === form.confirmPassword
    && !fieldErrors.companyName
    && !fieldErrors.email
    && !fieldErrors.phone
    && !fieldErrors.password
    && !fieldErrors.confirmPassword;

  const onIndustrySelectChange = (value: string) => {
    setIndustrySelect(value);
    if (value === 'Other') set('industry', '');
    else set('industry', value);
  };

  const goStep2 = () => {
    setTouched({
      companyName: true,
      fullName: true,
      email: true,
      phone: true,
      password: true,
      confirmPassword: true,
    });
    if (!step1Ready) return;
    setStep(2);
    setError('');
  };

  const finishLogin = async (session: unknown) => {
    if (session && onSession) {
      onSession(session);
      return;
    }
    const { data } = await supabase.auth.signInWithPassword({
      email: form.email.trim(),
      password: form.password,
    });
    if (data.session && onSession) onSession(data.session);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 1) {
      goStep2();
      return;
    }
    if (industryIsOther && !form.industry.trim()) {
      setTouched((t) => ({ ...t, industry: true }));
      return;
    }

    setLoading(true);
    setError('');
    try {
      const { data, error: signupError } = await supabase.auth.signUp({
        email: form.email.trim(),
        password: form.password,
        options: {
          emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
          data: {
            full_name: form.fullName.trim(),
            company_name: form.companyName.trim(),
            registration_type: 'company',
            phone: form.phone.trim(),
            industry: form.industry,
            employee_count: form.employeeCount,
            subscription_plan: 'trial',
          },
        },
      });
      if (signupError) throw signupError;

      await notifyPlatformOwnerOfRegistration(form);

      if (data.session) {
        await finishLogin(data.session);
        return;
      }

      await sendSignupOtp(form.email.trim());
      setOtpHint(`We sent a 6-digit code to ${form.email.trim()}.`);
      setPhase('verify');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const trimmed = otp.replace(/\s/g, '');
      const { data: otpData, error: otpErr } = await supabase.auth.verifyOtp({
        email: form.email.trim(),
        token: trimmed,
        type: 'signup',
      });
      if (!otpErr && otpData.session) {
        await finishLogin(otpData.session);
        return;
      }
      await verifySignupOtp(form.email.trim(), trimmed);
      await finishLogin(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not verify that code.');
    } finally {
      setLoading(false);
    }
  };

  const resendCode = async () => {
    setLoading(true);
    setError('');
    try {
      await sendSignupOtp(form.email.trim());
      setOtpHint('A new code is on the way.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not resend the code.');
    } finally {
      setLoading(false);
    }
  };

  const wrapClass = `${embedded ? '' : 'glass-panel '}company-register${embedded ? ' company-register--embedded' : ''}`;

  if (phase === 'verify') {
    return (
      <div className={wrapClass}>
        <div className="company-register__head">
          <div className="company-register__head-icon"><Mail size={22} /></div>
          <div>
            <p className="company-register__progress">Verify email</p>
            <h2 className="company-register__title">Enter your code</h2>
            <p className="company-register__intro">{otpHint}</p>
          </div>
        </div>
        {error && (
          <div className="company-register__banner"><AlertCircle size={16} /> {error}</div>
        )}
        <form onSubmit={handleVerify}>
          <label className="company-register__field">
            <span>6-digit code</span>
            <input
              className="input-field company-register__otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              autoFocus
            />
          </label>
          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '1rem' }} disabled={loading || otp.length !== 6}>
            {loading ? <><Loader2 size={16} className="animate-spin" /> Verifying…</> : 'Verify and continue'}
          </button>
          <button type="button" className="btn btn-secondary" style={{ width: '100%', marginTop: '0.5rem' }} disabled={loading} onClick={() => void resendCode()}>
            Resend code
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={wrapClass}>
      {!embedded && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onBack} style={{ marginBottom: '1rem' }}>
          <ArrowLeft size={14} /> Back
        </button>
      )}

      <div className="company-register__head">
        <div className="company-register__head-icon"><Building2 size={22} /></div>
        <div>
          <p className="company-register__progress">Step {step} of 2</p>
          <h2 className="company-register__title">
            {step === 1 ? 'Create your company account' : 'A bit about your team'}
          </h2>
          <p className="company-register__intro">
            {step === 1
              ? 'Takes about a minute. After you verify your email, the platform owner (info@walfia.ai) must approve your organization before you can use Scorr.'
              : 'Optional — you can skip this and add details later.'}
          </p>
        </div>
      </div>

      <ol className="company-register__steps" aria-label="Registration progress">
        <li className={step === 1 ? 'is-active' : 'is-done'}>Account</li>
        <li className={step === 2 ? 'is-active' : ''}>Company</li>
      </ol>

      {error && (
        <div className="company-register__banner"><AlertCircle size={16} /> {error}</div>
      )}

      <form onSubmit={handleSubmit}>
        {step === 1 && (
          <div className="company-register__grid">
            <label className="company-register__field" style={{ gridColumn: '1 / -1' }}>
              <span>Company name *</span>
              <input
                className={`input-field${show('companyName') ? ' is-invalid' : ''}`}
                value={form.companyName}
                onChange={(e) => set('companyName', e.target.value)}
                onBlur={() => blur('companyName')}
                placeholder="Acme Corporation"
                autoComplete="organization"
              />
              <Hint error={show('companyName')} ok={form.companyName.trim().length >= 2 ? 'Looks good' : undefined} />
            </label>
            <label className="company-register__field" style={{ gridColumn: '1 / -1' }}>
              <span>Your name *</span>
              <input
                className={`input-field${show('fullName') ? ' is-invalid' : ''}`}
                value={form.fullName}
                onChange={(e) => set('fullName', e.target.value)}
                onBlur={() => blur('fullName')}
                placeholder="Jane Doe"
                autoComplete="name"
              />
              <Hint error={show('fullName')} />
            </label>
            <label className="company-register__field">
              <span><Mail size={12} /> Admin email *</span>
              <input
                className={`input-field${show('email') ? ' is-invalid' : ''}`}
                type="email"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                onBlur={() => blur('email')}
                placeholder="admin@company.com"
                autoComplete="email"
              />
              <Hint error={show('email')} ok={EMAIL_RE.test(form.email.trim()) ? 'Valid email' : undefined} />
            </label>
            <label className="company-register__field">
              <span><Phone size={12} /> Phone *</span>
              <input
                className={`input-field${show('phone') ? ' is-invalid' : ''}`}
                type="tel"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                onBlur={() => blur('phone')}
                placeholder="+92 300 1234567"
                autoComplete="tel"
              />
              <Hint error={show('phone')} ok={phoneDigits(form.phone).length >= 7 ? 'Looks good' : undefined} />
            </label>
            <label className="company-register__field">
              <span>Password *</span>
              <PasswordField
                className={`input-field${show('password') ? ' is-invalid' : ''}`}
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                onBlur={() => blur('password')}
                placeholder="At least 6 characters"
                autoComplete="new-password"
              />
              <Hint error={show('password')} ok={form.password.length >= 6 ? 'Strong enough' : undefined} />
            </label>
            <label className="company-register__field">
              <span>Confirm password *</span>
              <PasswordField
                className={`input-field${show('confirmPassword') ? ' is-invalid' : ''}`}
                value={form.confirmPassword}
                onChange={(e) => set('confirmPassword', e.target.value)}
                onBlur={() => blur('confirmPassword')}
                placeholder="Repeat password"
                autoComplete="new-password"
              />
              <Hint
                error={show('confirmPassword')}
                ok={form.confirmPassword.length > 0 && form.password === form.confirmPassword ? 'Passwords match' : undefined}
              />
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="company-register__grid">
            <label className="company-register__field">
              <span>Industry <small>(optional)</small></span>
              <select
                className="input-field"
                value={industrySelect}
                onChange={(e) => onIndustrySelectChange(e.target.value)}
              >
                <option value="">Select industry</option>
                {presetIndustries.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
                <option value="Other">Other</option>
              </select>
            </label>
            {industryIsOther && (
              <label className="company-register__field">
                <span>Your industry</span>
                <input
                  className="input-field"
                  value={form.industry}
                  onChange={(e) => set('industry', e.target.value)}
                  onBlur={() => blur('industry')}
                  placeholder="e.g. Construction"
                />
                <Hint error={show('industry')} />
              </label>
            )}
            <label className="company-register__field">
              <span>Number of employees <small>(optional)</small></span>
              <select className="input-field" value={form.employeeCount} onChange={(e) => set('employeeCount', e.target.value)}>
                <option value="">Select range</option>
                {EMPLOYEE_COUNT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          </div>
        )}

        <div className="company-register__actions">
          {step === 2 && (
            <button type="button" className="btn btn-secondary" onClick={() => setStep(1)} disabled={loading}>
              <ArrowLeft size={14} /> Back
            </button>
          )}
          {step === 1 ? (
            <button type="submit" className="btn btn-primary" disabled={!step1Ready}>
              Continue <ArrowRight size={14} />
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? <><Loader2 size={16} className="animate-spin" /> Creating account…</> : <><CheckCircle2 size={16} /> Create account</>}
            </button>
          )}
        </div>
        <p className="company-register__legal">
          By continuing you agree to Scorr’s monitoring and data usage policy. No credit card required.
        </p>
      </form>
    </div>
  );
}
