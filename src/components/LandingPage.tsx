import { useEffect, useRef, useState } from 'react';
import Login from './Login';
import ThemeToggle from './ThemeToggle';
import ScorrWordmark from './ScorrWordmark';
import MobileAppDownload from './MobileAppDownload';
import {
  BarChart3, Trophy, CalendarCheck, Users, FileSpreadsheet, Bell,
  Sparkles, Shield, Check, ArrowRight, CreditCard,
  TrendingUp, Target, Award, Clock, Building2, Radio,
  MapPin, Menu, X, Download,
} from 'lucide-react';
import '../styles/landing.css';

interface LandingPageProps {
  onLoginSuccess: (session: unknown) => void;
}

const FEATURES = [
  { icon: Target, title: 'KPI & Task Management', desc: 'Managers assign tasks with deadlines. Employees track progress and mark complete before due dates.', color: '#2dd4a8' },
  { icon: Trophy, title: 'Rewards & Points', desc: 'Monthly KPI scores convert to points. Redeem catalog rewards — tiers from 250 to 1,000 points.', color: '#fbbf24' },
  { icon: CalendarCheck, title: 'Attendance & Leave', desc: 'Daily check-in, leave requests, manager approvals, CSV export, and balance tracking.', color: '#38bdf8' },
  { icon: Radio, title: 'Live GPS Tracking', desc: 'Office geofencing, live location visibility for managers, and attendance tied to approved sites.', color: '#a78bfa' },
  { icon: Users, title: 'Team Leaderboard', desc: 'Managers view team rankings, health scores, and drill into individual performance.', color: '#34d399' },
  { icon: FileSpreadsheet, title: 'Reports & Export', desc: 'Monthly and quarterly reports in PDF, Excel, and CSV with KPI snapshots and AI insights.', color: '#2dd4a8' },
  { icon: Bell, title: 'Smart Notifications', desc: 'In-app alerts and email for KPI overdue, completions, leave requests, and reward redemptions.', color: '#f87171' },
  { icon: Sparkles, title: 'AI Insights', desc: 'Automated narratives, suggested targets, and performance stories powered by your KPI data.', color: '#38bdf8' },
  { icon: Shield, title: 'Role-Based Access', desc: 'Secure admin, manager, and employee dashboards with Supabase auth and row-level security.', color: '#94a3b8' },
];

const PLANS = [
  {
    name: 'Starter',
    price: '0',
    period: '3-day free trial, then $12/user/mo',
    featured: false,
    features: ['3-day full platform trial', 'Up to 25 employees', 'KPI task assignment', 'Basic rewards catalog', 'Mobile-friendly PWA'],
  },
  {
    name: 'Professional',
    price: '18',
    period: 'per active user / month',
    featured: true,
    features: ['Everything after trial', 'Unlimited employees', 'Attendance, leave & GPS', 'Analytics & PDF/Excel reports', 'AI insights & narratives', 'Priority email support'],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: 'volume pricing available',
    featured: false,
    features: ['Everything in Professional', 'SSO & HRIS integration', 'White-label branding', 'Dedicated account manager', 'Custom SLA & onboarding', 'Annual billing discounts'],
  },
];

const FEE_STEPS = [
  { icon: Clock, title: 'Start with a 3-day free trial', desc: 'Explore the full Professional experience for 3 days. No credit card required — register your company to begin.' },
  { icon: Users, title: 'Pay per active seat', desc: 'You are billed only for active users (employees, managers, admins) each month. Remove seats anytime.' },
  { icon: CreditCard, title: 'Simple monthly billing', desc: 'Invoices are generated on the 1st of each month. Pay by card or bank transfer. Receipts sent automatically.' },
  { icon: TrendingUp, title: 'Scale as you grow', desc: 'Upgrade from Starter to Professional instantly. Add users without contracts — pricing adjusts on your next cycle.' },
  { icon: Award, title: 'No hidden fees', desc: 'Points, reports, attendance, and exports are included. Enterprise adds custom integrations — quoted upfront.' },
];

const MARQUEE_ITEMS = [
  'KPI Tracking', 'Rewards Points', 'Daily Attendance', 'Leave Management',
  'Live GPS Tracking', 'Team Leaderboard', 'PDF Reports', 'AI Insights',
  'Company Registration', 'Android APK Download', 'HR Analytics', 'Manager Approvals',
];

const TRUST_ITEMS = [
  '3-day free trial',
  'Per-seat pricing',
  'Company data isolation',
  'Admin approval workflow',
  'Android APK download',
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
  const [val, setVal] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      let start = 0;
      const step = target / 40;
      const id = setInterval(() => {
        start += step;
        if (start >= target) { setVal(target); clearInterval(id); }
        else setVal(Math.floor(start));
      }, 30);
      obs.disconnect();
    }, { threshold: 0.5 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [target]);
  return <span ref={ref}>{val}{suffix}</span>;
}

export default function LandingPage({ onLoginSuccess }: LandingPageProps) {
  const [navScrolled, setNavScrolled] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const revealRef = useReveal();

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
    setAuthMode('register');
    scrollTo('login');
  };

  const openLogin = () => {
    setAuthMode('login');
    scrollTo('login');
  };

  const navLinks = [
    { id: 'services', label: 'Services' },
    { id: 'how-it-works', label: 'How It Works' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'download-app', label: 'Mobile App' },
    { id: 'fees', label: 'Billing' },
    { id: 'login', label: 'Sign In' },
  ];

  return (
    <div className="landing" ref={revealRef}>
      <nav className={`landing-nav ${navScrolled ? 'landing-nav--scrolled' : ''}`}>
        <ScorrWordmark className="landing-nav__logo" variant="header" />
        <div className="landing-nav__links">
          {navLinks.slice(0, 5).map((link) => (
            <a key={link.id} href={`#${link.id}`} onClick={(e) => { e.preventDefault(); scrollTo(link.id); }}>{link.label}</a>
          ))}
        </div>
        <div className="landing-nav__cta">
          <ThemeToggle compact />
          <button type="button" className="btn btn-secondary btn-sm landing-nav__signin" onClick={openLogin}>Sign In</button>
          <button type="button" className="btn btn-primary btn-sm landing-nav__register" onClick={openRegister}>
            Register Company <ArrowRight size={14} />
          </button>
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
                <button key={link.id} type="button" onClick={() => scrollTo(link.id)}>{link.label}</button>
              ))}
            </nav>
            <div className="landing-mobile-drawer__actions">
              <button type="button" className="btn btn-secondary" onClick={openLogin}>Sign In</button>
              <button type="button" className="btn btn-primary" onClick={openRegister}>
                Register Company <Building2 size={15} />
              </button>
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
              <Sparkles size={14} /> 3-Day Free Trial · Company Registration Open
            </div>
            <h1 className="landing-hero__title">
              HR performance, rewards & attendance — <span>one platform</span>
            </h1>
            <p className="landing-hero__desc">
              Scorr helps admins, managers, and employees stay aligned on KPIs, attendance, leave, live GPS tracking, and rewards — with clear dashboards and professional reporting.
            </p>
            <div className="landing-hero__actions">
              <button type="button" className="btn btn-primary" onClick={openRegister}>
                Register Company — Free for 3 Days <ArrowRight size={16} />
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => scrollTo('download-app')}>
                <Download size={16} /> Download Android App
              </button>
              <button type="button" className="btn btn-secondary" onClick={openLogin}>
                Sign In
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => scrollTo('pricing')}>
                View Pricing
              </button>
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
            <div className="landing-float-card landing-float-card--1">
              <div className="landing-float-card__icon" style={{ background: 'rgba(45,212,168,0.15)', color: '#2dd4a8' }}>
                <BarChart3 size={18} />
              </div>
              <div className="landing-float-card__title">Health Score</div>
              <div className="landing-float-card__val" style={{ color: '#2dd4a8' }}>92%</div>
              <div className="landing-progress"><div className="landing-progress__bar" style={{ width: '92%' }} /></div>
            </div>
            <div className="landing-float-card landing-float-card--2">
              <div className="landing-float-card__icon" style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
                <Trophy size={18} />
              </div>
              <div className="landing-float-card__title">Points Earned</div>
              <div className="landing-float-card__val" style={{ color: '#fbbf24' }}>1,000</div>
              <div className="landing-progress"><div className="landing-progress__bar" style={{ width: '100%' }} /></div>
            </div>
            <div className="landing-float-card landing-float-card--3">
              <div className="landing-float-card__icon" style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>
                <MapPin size={18} />
              </div>
              <div className="landing-float-card__title">GPS Check-in</div>
              <div className="landing-float-card__val" style={{ color: '#38bdf8' }}>Live</div>
              <div className="landing-progress"><div className="landing-progress__bar" style={{ width: '88%' }} /></div>
            </div>
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
          <h2 className="landing-section__title">Everything your HR team needs</h2>
          <p>From task assignment to reward redemption — Scorr connects performance, attendance, GPS tracking, and recognition in one professional dashboard.</p>
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
          <p>Register your company, get approved, and launch a structured performance loop for your entire organization.</p>
        </div>
        <div className="landing-steps" style={{ maxWidth: 1200, margin: '0 auto' }}>
          {[
            { n: 1, title: 'Register your company', desc: 'Submit organization details and choose a plan. Start with a 3-day free trial while approval is processed.' },
            { n: 2, title: 'Manager assigns tasks', desc: 'Set KPIs with deadlines and departments for each employee.' },
            { n: 3, title: 'Employee delivers', desc: 'Track progress, check in daily, request leave, and mark tasks complete on time.' },
            { n: 4, title: 'Score, reward & report', desc: 'Monthly scores convert to points. Leadership exports analytics and manages the full org.' },
          ].map((s, i) => (
            <div key={s.n} className={`landing-step landing-reveal landing-reveal--delay-${i + 1}`}>
              <div className="landing-step__num">{s.n}</div>
              <h4>{s.title}</h4>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="landing-section">
        <div className="landing-section__header landing-reveal">
          <div className="landing-section__eyebrow">Pricing</div>
          <h2 className="landing-section__title">Transparent plans for every team</h2>
          <p>Every new company starts with a <strong>3-day free trial</strong>. Scale when ready — secure cloud hosting and updates included.</p>
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
              <button
                type="button"
                className={`btn ${plan.featured || plan.price === '0' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ width: '100%' }}
                onClick={plan.name === 'Enterprise' ? () => scrollTo('login') : openRegister}
              >
                {plan.name === 'Enterprise' ? 'Contact Sales' : plan.price === '0' ? 'Start 3-Day Trial' : 'Get Started'}
              </button>
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
                ≥90% score → 1,000 pts · 80–89% → 500 · 70–79% → 250 · below 70% → 0. Points are included at no extra cost.
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
                <>Each company gets isolated data — your own admins, managers, and employees. New organizations receive a <strong>3-day free trial</strong> while registration is reviewed.</>
              ) : (
                <>Access your company dashboard at <strong className="landing-accent-text">scorr.walfia.ai</strong>. Use your approved company credentials, or try the isolated <strong>3-day demo sandbox</strong> below.</>
              )}
            </p>
            <ul className="landing-login-list">
              {(authMode === 'register'
                ? ['Fill organization & contact details', 'Choose subscription plan', 'Start 3-day free trial period', 'Wait for admin approval, then sign in']
                : ['Employee — KPIs, attendance & rewards', 'Manager — assign tasks, approve leave', 'Admin — users, reports & branding']
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
            <Login
              onLoginSuccess={onLoginSuccess}
              embedded
              enableCompanyRegister
              authMode={authMode}
              onAuthModeChange={setAuthMode}
              showDemoShortcuts={authMode === 'login'}
              demoSectionLabel="3-day demo sandbox"
            />
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__brand">
            <ScorrWordmark className="landing-footer__logo" variant="header" />
            <p>Performance, attendance, and rewards for modern HR teams.</p>
          </div>
          <div className="landing-footer__links">
            <button type="button" onClick={() => scrollTo('pricing')}>Pricing</button>
            <button type="button" onClick={openRegister}>Register Company</button>
            <button type="button" onClick={openLogin}>Sign In</button>
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
