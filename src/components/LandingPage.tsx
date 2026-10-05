import { useEffect, useRef, useState, lazy, Suspense, type MouseEvent } from 'react';
import ThemeToggle from './ThemeToggle';
import ScorrWordmark from './ScorrWordmark';
import MobileAppDownload from './MobileAppDownload';
import {
  Trophy, CalendarCheck, Users, FileSpreadsheet, Bell,
  Shield, Check, ArrowRight, CreditCard,
  TrendingUp, Target, Award, Clock, Building2, Radio,
  Menu, X, Download, Apple, KeyRound, Lock, Smartphone,
} from 'lucide-react';
import '../styles/landing.css';
import LandingHeroVisual from './LandingHeroVisual';
import {
  androidInstallHref,
  androidInstallIsDownload,
  iosInstallHref,
  iosInstallIsAppStore,
  showStoreInstallCtas,
} from '../utils/appStoreLinks';

const Login = lazy(() => import('./Login'));

interface LandingPageProps {
  onLoginSuccess: (session: unknown) => void;
}

const FEATURES = [
  {
    icon: Target,
    title: 'KPI Weightage & Score',
    desc: 'Weightage stays within 0–100%. Score is a points index that can rise above 100 when people over-deliver. Overall, Month, and Year views stay independent.',
    color: '#2dd4a8',
  },
  {
    icon: Trophy,
    title: 'Rewards & Points',
    desc: 'Hit monthly weightage targets to unlock company gifts and catalog rewards. Redeem with weightage.',
    color: '#fbbf24',
  },
  {
    icon: CalendarCheck,
    title: 'Shifts & Attendance',
    desc: 'Day and overnight shifts, GPS check-in/out, multi-visit days, and automatic clock-out when the shift ends — with admin history that stays accurate.',
    color: '#38bdf8',
  },
  {
    icon: Radio,
    title: 'Live GPS Tracking',
    desc: 'Geofenced office sites, live location for managers, and attendance tied to approved work locations.',
    color: '#34d399',
  },
  {
    icon: Bell,
    title: 'Completion Emails',
    desc: 'When someone marks a KPI complete, email and in-app alerts go to their reporting manager and the person who assigned the task.',
    color: '#f87171',
  },
  {
    icon: KeyRound,
    title: 'Authenticator & Backup Codes',
    desc: 'Privileged roles enroll Google Authenticator or Microsoft Authenticator, save one-time backup codes, and can recover with login-email OTP if the device is lost.',
    color: '#0d9488',
  },
  {
    icon: Users,
    title: 'People & Scoreboards',
    desc: 'Admin and manager boards show each person’s overall score, month score, and weightage — same math as the employee scoreboard.',
    color: '#38bdf8',
  },
  {
    icon: FileSpreadsheet,
    title: 'Reports & Export',
    desc: 'Export attendance and KPI snapshots for the month or year. Leadership gets clear period vs overall performance.',
    color: '#2dd4a8',
  },
  {
    icon: Shield,
    title: 'Company Isolation',
    desc: 'Each company is isolated with role-based dashboards (admin, HR, manager, employee) and secure cloud authentication.',
    color: '#94a3b8',
  },
];

const SECURITY_POINTS = [
  {
    icon: Smartphone,
    title: 'Authenticator app (TOTP)',
    desc: 'Admins, managers, HR, and employees enroll Google Authenticator or Microsoft Authenticator after sign-in. Every privileged session requires a fresh 6-digit code.',
  },
  {
    icon: KeyRound,
    title: 'Backup recovery codes',
    desc: 'One-time backup codes are generated after setup. Store them offline — each code works once if the phone is unavailable.',
  },
  {
    icon: Lock,
    title: 'Email OTP recovery',
    desc: 'No authenticator or codes left? Verify with a code sent to the login email, then re-enroll MFA and save new backup codes.',
  },
  {
    icon: Shield,
    title: 'Account security settings',
    desc: 'Inside Scorr, Account Security lets people regenerate backup codes, set a recovery email, and review recent recovery activity.',
  },
];

const PLANS = [
  {
    name: 'Starter',
    price: '0',
    period: '3-day free trial, then $12/user/mo',
    featured: false,
    features: [
      '3-day full platform trial',
      'Up to 25 employees',
      'KPI weightage & scoreboards',
      'Authenticator MFA & backup codes',
      'Basic rewards catalog',
      'Mobile-friendly PWA',
    ],
  },
  {
    name: 'Professional',
    price: '18',
    period: 'per active user / month',
    featured: true,
    features: [
      'Everything after trial',
      'Unlimited employees',
      'Shifts, leave & GPS attendance',
      'Completion emails to managers',
      'Analytics & exports',
      'Priority email support',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: 'volume pricing available',
    featured: false,
    features: [
      'Everything in Professional',
      'SSO & HRIS integration',
      'White-label branding',
      'Dedicated account manager',
      'Custom SLA & onboarding',
      'Annual billing discounts',
    ],
  },
];

const FEE_STEPS = [
  { icon: Clock, title: 'Start with a 3-day free trial', desc: 'Explore the full Professional experience for 3 days. No credit card required — register your company to begin.' },
  { icon: Users, title: 'Pay per active seat', desc: 'You are billed only for active users (employees, managers, admins) each month. Remove seats anytime.' },
  { icon: CreditCard, title: 'Simple monthly billing', desc: 'Invoices are generated on the 1st of each month. Pay by card or bank transfer. Receipts sent automatically.' },
  { icon: TrendingUp, title: 'Scale as you grow', desc: 'Upgrade from Starter to Professional instantly. Add users without contracts — pricing adjusts on your next cycle.' },
  { icon: Award, title: 'Security included', desc: 'Authenticator MFA, backup codes, email recovery, and company data isolation ship with every plan — no add-on fee.' },
];

const MARQUEE_ITEMS = [
  'KPI Weightage', 'Score Index', 'Rewards Points', 'Night Shifts',
  'GPS Check-in', 'Auto Clock-out', 'Completion Emails', 'Authenticator MFA',
  'Backup Codes', 'Email OTP Recovery', 'Team Scoreboards', 'Attendance Export',
];

const TRUST_ITEMS = [
  '3-day free trial',
  'Authenticator MFA',
  'Backup recovery codes',
  'Company data isolation',
  'Android APK download',
  'iPhone Home Screen app',
  'Demo sandbox available',
];

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('landing-reveal--visible')),
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    el.querySelectorAll('.landing-reveal').forEach((node) => obs.observe(node));
    return () => obs.disconnect();
  }, []);
  return ref;
}

function AnimatedCounter({ target, suffix = '' }: { target: number; suffix?: string }) {
  // Final value on first paint (SSR + client) so Speed Index isn't held by counting.
  // Desktop-only count-up after mount; skip on mobile and prefers-reduced-motion.
  const [val, setVal] = useState(target);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mobile = window.matchMedia('(max-width: 960px)').matches;
    if (reduceMotion || mobile) return;

    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || cancelled) return;
      obs.disconnect();
      setVal(0);
      let start = 0;
      const step = target / 40;
      intervalId = setInterval(() => {
        start += step;
        if (start >= target) {
          setVal(target);
          if (intervalId) clearInterval(intervalId);
        } else {
          setVal(Math.floor(start));
        }
      }, 30);
    }, { threshold: 0.5 });
    obs.observe(el);
    return () => {
      cancelled = true;
      obs.disconnect();
      if (intervalId) clearInterval(intervalId);
    };
  }, [target]);

  return <span ref={ref}>{val}{suffix}</span>;
}

function wantsAuthOnLoad(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.location.hash.replace(/^#/, '') === 'login') return true;
    const q = new URLSearchParams(window.location.search);
    return q.get('demo') === '1' || q.get('auth') === '1';
  } catch {
    return false;
  }
}

export default function LandingPage({ onLoginSuccess }: LandingPageProps) {
  const [navScrolled, setNavScrolled] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  /**
   * Always start false so SSR prerender matches the first client paint.
   * Deep-link auth (?demo=1 / #login) opens after mount.
   */
  const [authMounted, setAuthMounted] = useState(false);
  const [showDemoShortcuts, setShowDemoShortcuts] = useState(false);
  const revealRef = useReveal();

  useEffect(() => {
    if (wantsAuthOnLoad()) setAuthMounted(true);
    try {
      setShowDemoShortcuts(new URLSearchParams(window.location.search).get('demo') === '1');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = mobileNavOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileNavOpen]);

  const scrollTo = (id: string) => {
    setMobileNavOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  const openRegister = () => {
    setAuthMounted(true);
    setAuthMode('register');
    scrollTo('login');
    try {
      window.history.pushState({ scorrLanding: 'register' }, '', '#login');
    } catch {
      /* ignore */
    }
  };

  const openLogin = () => {
    setAuthMounted(true);
    setAuthMode('login');
    scrollTo('login');
    try {
      window.history.pushState({ scorrLanding: 'login' }, '', '#login');
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const onPop = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash === 'login') {
        setAuthMounted(true);
        scrollTo('login');
        return;
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navLinks = [
    { id: 'services', label: 'Services' },
    { id: 'how-it-works', label: 'How It Works' },
    { id: 'security', label: 'Security' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'download-app', label: 'Mobile App' },
    { id: 'login', label: 'Sign In' },
  ];

  const onSectionNav = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    scrollTo(id);
  };

  const onLoginNav = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    openLogin();
  };

  const onRegisterNav = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    openRegister();
  };

  return (
    <div className="landing" ref={revealRef}>
      <nav className={`landing-nav ${navScrolled ? 'landing-nav--scrolled' : ''}`}>
        <a href="https://scorr.walfia.ai/" className="landing-nav__home" aria-label="Scorr home">
          <ScorrWordmark className="landing-nav__logo" variant="header" />
        </a>
        <div className="landing-nav__links">
          {navLinks.filter((l) => l.id !== 'login').map((link) => (
            <a
              key={link.id}
              href={`#${link.id}`}
              onClick={(e) => onSectionNav(e, link.id)}
            >
              {link.label}
            </a>
          ))}
        </div>
        <div className="landing-nav__cta">
          <ThemeToggle compact />
          <a href="#login" className="btn btn-secondary btn-sm landing-nav__signin" onClick={onLoginNav}>
            Sign In
          </a>
          <a href="#login" className="btn btn-primary btn-sm landing-nav__register" onClick={onRegisterNav}>
            Register Company <ArrowRight size={14} />
          </a>
          <button
            type="button"
            className="landing-nav__menu-btn"
            aria-expanded={mobileNavOpen}
            aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            {mobileNavOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </nav>

      {mobileNavOpen && (
        <div className="landing-mobile-drawer landing-mobile-drawer--open">
          <button type="button" className="landing-mobile-drawer__backdrop" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} />
          <aside className="landing-mobile-drawer__panel">
            <div className="landing-mobile-drawer__head">
              <span className="landing-mobile-drawer__eyebrow">Scorr</span>
              <strong>Explore the platform</strong>
            </div>
            <nav className="landing-mobile-drawer__nav">
              {navLinks.map((link) => (
                <a
                  key={link.id}
                  href={`#${link.id}`}
                  onClick={(e) => {
                    if (link.id === 'login') onLoginNav(e);
                    else onSectionNav(e, link.id);
                  }}
                >
                  {link.label}
                </a>
              ))}
            </nav>
            <div className="landing-mobile-drawer__actions">
              <a href="#login" className="btn btn-secondary" onClick={onLoginNav}>Sign In</a>
              <a href="#login" className="btn btn-primary" onClick={onRegisterNav}>
                Register Company <Building2 size={15} />
              </a>
            </div>
          </aside>
        </div>
      )}

      <section className="landing-hero">
        <div className="landing-hero__bg">
          <div className="landing-grid-bg" />
          <div className="landing-orb landing-orb--1" />
          <div className="landing-orb landing-orb--2" />
          <div className="landing-orb landing-orb--3" />
        </div>
        <div className="landing-hero__inner">
          <div>
            <div className="landing-hero__badge">
              <Shield size={14} /> Authenticator MFA · Backup codes · 3-day free trial
            </div>
            <h1 className="landing-hero__title">
              Performance, attendance &amp; secure access — <span>one platform</span>
            </h1>
            <p className="landing-hero__desc">
              Scorr aligns KPIs (weightage vs score), GPS attendance, overnight shifts, and rewards —
              protected with authenticator apps, backup codes, and email recovery for every privileged login.
            </p>
            <div className="landing-hero__actions">
              <a href="#login" className="btn btn-primary" onClick={onRegisterNav}>
                Register Company — Free for 3 Days <ArrowRight size={16} />
              </a>
              {showStoreInstallCtas() && (
                <>
                  <a
                    href="#download-app"
                    className="btn btn-secondary"
                    onClick={(e: MouseEvent<HTMLAnchorElement>) => onSectionNav(e, 'download-app')}
                  >
                    <Download size={16} /> Download Desktop App
                  </a>
                  <a
                    href={androidInstallHref()}
                    className="btn btn-secondary"
                    {...(androidInstallIsDownload()
                      ? { download: 'scorr.apk' }
                      : { target: '_blank', rel: 'noopener noreferrer' })}
                  >
                    <Download size={16} /> Download Android App
                  </a>
                  <a
                    href={iosInstallIsAppStore() ? iosInstallHref() : '#download-app'}
                    className="btn btn-secondary"
                    {...(iosInstallIsAppStore()
                      ? { target: '_blank', rel: 'noopener noreferrer' }
                      : { onClick: (e: MouseEvent<HTMLAnchorElement>) => onSectionNav(e, 'download-app') })}
                  >
                    <Apple size={16} /> Install on iPhone
                  </a>
                </>
              )}
              <a href="#login" className="btn btn-secondary" onClick={onLoginNav}>
                Sign In
              </a>
              <a href="#pricing" className="btn btn-secondary" onClick={(e) => onSectionNav(e, 'pricing')}>
                View Pricing
              </a>
            </div>
            <div className="landing-trust-bar">
              {TRUST_ITEMS.map((item) => (
                <span key={item}><Check size={14} /> {item}</span>
              ))}
            </div>
            <div className="landing-hero__stats">
              <div>
                <div className="landing-stat__value"><AnimatedCounter target={3} /></div>
                <div className="landing-stat__label">Day Free Trial</div>
              </div>
              <div>
                <div className="landing-stat__value"><AnimatedCounter target={3} /></div>
                <div className="landing-stat__label">Role Dashboards</div>
              </div>
              <div>
                <div className="landing-stat__value"><AnimatedCounter target={1000} suffix="+" /></div>
                <div className="landing-stat__label">Max Points / Month</div>
              </div>
            </div>
          </div>

          <div className="landing-hero__visual" aria-hidden>
            <LandingHeroVisual />
          </div>
        </div>
      </section>

      <div className="landing-marquee-wrap">
        <div className="landing-marquee">
          {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((item, i) => (
            <span key={i}>{item}</span>
          ))}
        </div>
      </div>

      <section id="services" className="landing-section">
        <div className="landing-section__header landing-reveal">
          <div className="landing-section__eyebrow">What We Offer</div>
          <h2 className="landing-section__title">Built for how teams work now</h2>
          <p>
            Clear KPI math, shift-aware attendance, completion emails, and authenticator security —
            so admins, managers, and employees stay aligned without spreadsheet chaos.
          </p>
        </div>
        <div className="landing-features">
          {FEATURES.map((f, i) => (
            <div key={f.title} className={`landing-feature landing-reveal landing-reveal--delay-${(i % 3) + 1}`}>
              <div className="landing-feature__icon" style={{ background: `${f.color}18`, color: f.color }}>
                <f.icon size={22} />
              </div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="landing-section landing-section--wide landing-section--alt">
        <div className="landing-section__header landing-reveal">
          <div className="landing-section__eyebrow">Workflow</div>
          <h2 className="landing-section__title">How Scorr works</h2>
          <p>Register your company, secure every login, then run a clean performance and attendance loop.</p>
        </div>
        <div className="landing-steps" style={{ maxWidth: 1200, margin: '0 auto' }}>
          {[
            { n: 1, title: 'Register & verify', desc: 'Create the company, confirm email, then wait for approval from info@walfia.ai before using Scorr.' },
            { n: 2, title: 'Secure the account', desc: 'Enroll an authenticator, save backup codes, and optionally set recovery email — required for privileged roles.' },
            { n: 3, title: 'Assign & deliver', desc: 'Managers assign weighted KPIs. People check in with GPS, work overnight shifts, and mark tasks complete.' },
            { n: 4, title: 'Score, notify & reward', desc: 'Scoreboards update Overall / Month / Year. Managers and assigners get completion emails. Points convert to catalog rewards.' },
          ].map((s, i) => (
            <div key={s.n} className={`landing-step landing-reveal landing-reveal--delay-${i + 1}`}>
              <div className="landing-step__num">{s.n}</div>
              <h4>{s.title}</h4>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="security" className="landing-section">
        <div className="landing-section__header landing-reveal">
          <div className="landing-section__eyebrow">Security &amp; credentials</div>
          <h2 className="landing-section__title">Sign-in that protects the whole company</h2>
          <p>
            Password alone is not enough for privileged work. Scorr requires authenticator MFA,
            issues backup codes, and offers login-email recovery when a device is lost.
          </p>
        </div>
        <div className="landing-features landing-features--security">
          {SECURITY_POINTS.map((item, i) => (
            <div key={item.title} className={`landing-feature landing-reveal landing-reveal--delay-${(i % 3) + 1}`}>
              <div className="landing-feature__icon" style={{ background: 'rgba(13,148,136,0.12)', color: '#0d9488' }}>
                <item.icon size={22} />
              </div>
              <h3>{item.title}</h3>
              <p>{item.desc}</p>
            </div>
          ))}
        </div>
        <div className="landing-security-note landing-reveal">
          <Lock size={18} />
          <div>
            <strong>What you need to sign in</strong>
            <span>
              Company login email and password, plus a current authenticator code (or one unused backup code).
              If both are gone, request an email OTP to your login address, then re-enroll MFA and save new codes.
            </span>
          </div>
        </div>
      </section>

      <section id="pricing" className="landing-section landing-section--alt">
        <div className="landing-section__header landing-reveal">
          <div className="landing-section__eyebrow">Pricing</div>
          <h2 className="landing-section__title">Transparent plans for every team</h2>
          <p>Every new company starts with a <strong>3-day free trial</strong>. MFA and company isolation are included — secure cloud hosting and updates on every plan.</p>
        </div>
        <div className="landing-pricing">
          {PLANS.map((plan, i) => (
            <div
              key={plan.name}
              className={`landing-price-card landing-reveal landing-reveal--delay-${i + 1} ${plan.featured ? 'landing-price-card--featured' : ''}`}
            >
              {plan.featured && <span className="landing-price-card__badge">Most Popular</span>}
              {plan.price === '0' && <span className="landing-price-card__badge landing-price-card__badge--trial">3-Day Trial</span>}
              <h3 style={{ fontSize: '1.15rem', marginBottom: '0.5rem' }}>{plan.name}</h3>
              <div className="landing-price-card__amount">
                {plan.price === 'Custom' ? plan.price : <>${plan.price}</>}
                {plan.price !== 'Custom' && plan.price !== '0' && <small>/mo</small>}
              </div>
              <p className="landing-price-card__period">{plan.period}</p>
              <ul>
                {plan.features.map((f) => (
                  <li key={f}><Check size={16} /> {f}</li>
                ))}
              </ul>
              <a
                href="#login"
                className={`btn ${plan.featured || plan.price === '0' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ width: '100%' }}
                onClick={plan.name === 'Enterprise' ? onLoginNav : onRegisterNav}
              >
                {plan.name === 'Enterprise' ? 'Contact Sales' : plan.price === '0' ? 'Start 3-Day Trial' : 'Get Started'}
              </a>
            </div>
          ))}
        </div>
      </section>

      <section id="fees" className="landing-fees">
        <div className="landing-fees__grid">
          <div className="landing-reveal">
            <div className="landing-section__eyebrow">Billing & Fees</div>
            <h2 className="landing-section__title landing-section__title--left">How our fee process works</h2>
            <p className="landing-fees__intro">
              No surprises. Scorr uses simple per-seat pricing with a <strong>3-day free trial</strong> so you can evaluate the full platform before committing.
            </p>
            <div className="landing-fees__highlight">
              <strong>Rewards points never expire.</strong>
              <p>
                Catalog and company gifts redeem with monthly weightage (0–100%). No score-point balances.
                Weightage stays 0–100%; score can exceed 100 when people over-deliver.
              </p>
            </div>
          </div>
          <div>
            {FEE_STEPS.map((step, i) => (
              <div key={step.title} className={`landing-fee-item landing-reveal landing-reveal--delay-${(i % 3) + 1}`}>
                <div className="landing-fee-item__icon"><step.icon size={18} /></div>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <MobileAppDownload />

      <section id="login" className="landing-login-section">
        <div className={`landing-login-grid ${authMode === 'register' ? 'landing-login-grid--register' : ''}`}>
          <div className="landing-reveal">
            <div className="landing-section__eyebrow">Get Started</div>
            <h2 className="landing-section__title landing-section__title--left">
              {authMode === 'register' ? 'Register your company' : 'Sign in to Scorr'}
            </h2>
            <p className="landing-login-copy">
              {authMode === 'register' ? (
                <>Create your company in two short steps. Verify your email and start a <strong>3-day free trial</strong> — then enroll authenticator MFA, add people, shifts, and KPIs.</>
              ) : (
                <>Access your company dashboard at <strong className="landing-accent-text">scorr.walfia.ai</strong>. Use your company credentials plus authenticator (or a backup code). Demo sandbox available below.</>
              )}
            </p>
            <ul className="landing-login-list">
              {(authMode === 'register'
                ? [
                    'Company name, admin email, phone & password',
                    'Verify email with a 6-digit code',
                    'Enroll authenticator & save backup codes',
                    'Guided setup: people, shifts, KPIs',
                  ]
                : [
                    'Password + authenticator code (or backup code)',
                    'Email OTP recovery if the device is lost',
                    'Employee — KPIs, attendance & rewards',
                    'Manager / Admin — assign tasks, approvals & reports',
                  ]
              ).map((t) => (
                <li key={t}><Check size={16} /> {t}</li>
              ))}
            </ul>
            <div className="landing-login-promo">
              <Clock size={18} />
              <div>
                <strong>3-day free subscription</strong>
                <span>Full platform access for new company registrations — no credit card required to start.</span>
              </div>
            </div>
          </div>
          <div className="landing-login-card-wrap landing-reveal landing-reveal--delay-2">
            {authMounted ? (
              <Suspense fallback={<div style={{ minHeight: 280 }} aria-hidden />}>
                <Login
                  onLoginSuccess={onLoginSuccess}
                  embedded
                  enableCompanyRegister
                  authMode={authMode}
                  onAuthModeChange={setAuthMode}
                  showDemoShortcuts={showDemoShortcuts && authMode === 'login'}
                  demoSectionLabel="3-day demo sandbox"
                />
              </Suspense>
            ) : (
              <div
                className="landing-auth-gate"
                style={{
                  minHeight: 280,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: '0.75rem',
                  padding: '1.5rem',
                }}
              >
                <a href="#login" className="btn btn-primary" onClick={onLoginNav}>
                  Sign In
                </a>
                <a href="#login" className="btn btn-secondary" onClick={onRegisterNav}>
                  Register Company
                </a>
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__brand">
            <ScorrWordmark className="landing-footer__logo" variant="header" />
            <p>Performance, attendance, rewards, and authenticator-secured access for modern HR teams.</p>
          </div>
          <div className="landing-footer__links">
            <a href="#security" onClick={(e) => onSectionNav(e, 'security')}>Security</a>
            <a href="#pricing" onClick={(e) => onSectionNav(e, 'pricing')}>Pricing</a>
            <a href="#login" onClick={onRegisterNav}>Register Company</a>
            <a href="#login" onClick={onLoginNav}>Sign In</a>
            <a href="/delete-account">Delete account</a>
            <a href="https://walfia.ai" target="_blank" rel="noreferrer">Walfia</a>
          </div>
        </div>
        <p className="landing-footer__copy">
          © {new Date().getFullYear()} Scorr · <a href="https://scorr.walfia.ai">scorr.walfia.ai</a>
        </p>
      </footer>
    </div>
  );
}
