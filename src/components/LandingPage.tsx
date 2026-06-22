import { useEffect, useRef, useState } from 'react';
import Login from './Login';
import ScorrWordmark from './ScorrWordmark';
import {
  BarChart3, Trophy, CalendarCheck, Users, FileSpreadsheet, Bell,
  Palette, Sparkles, Shield, Check, ArrowRight, Zap, CreditCard,
  TrendingUp, Target, Award,
} from 'lucide-react';
import '../styles/landing.css';

interface LandingPageProps {
  onLoginSuccess: (session: unknown) => void;
}

const FEATURES = [
  { icon: Target, title: 'KPI & Task Management', desc: 'Managers assign tasks with deadlines. Employees track progress and mark complete before due dates.', color: '#2dd4a8' },
  { icon: Trophy, title: 'Rewards & Points', desc: 'Monthly KPI scores convert to points. Redeem catalog rewards — tiers from 250 to 1,000 points.', color: '#fbbf24' },
  { icon: CalendarCheck, title: 'Attendance & Leave', desc: 'Daily check-in, leave requests, manager approvals, CSV export, and balance tracking.', color: '#38bdf8' },
  { icon: Users, title: 'Team Leaderboard', desc: 'Managers view team rankings, health scores, and drill into individual performance.', color: '#a78bfa' },
  { icon: FileSpreadsheet, title: 'Reports & Export', desc: 'Monthly and quarterly reports in PDF, Excel, and CSV with KPI snapshots and AI insights.', color: '#34d399' },
  { icon: Bell, title: 'Smart Notifications', desc: 'In-app alerts and email for KPI overdue, completions, leave requests, and reward redemptions.', color: '#f87171' },
  { icon: Sparkles, title: 'AI Insights', desc: 'Automated narratives, suggested targets, and performance stories powered by your KPI data.', color: '#38bdf8' },
  { icon: Palette, title: 'White-Label Branding', desc: 'Customize logo, colors, and company identity — make Scorr feel like your own platform.', color: '#2dd4a8' },
  { icon: Shield, title: 'Role-Based Access', desc: 'Secure admin, manager, and employee dashboards with Supabase auth and row-level security.', color: '#94a3b8' },
];

const PLANS = [
  {
    name: 'Starter',
    price: '0',
    period: '14-day free trial, then $12/user/mo',
    featured: false,
    features: ['Up to 25 employees', 'KPI task assignment', 'Basic rewards catalog', 'Email notifications', 'Mobile-friendly PWA'],
  },
  {
    name: 'Professional',
    price: '18',
    period: 'per active user / month',
    featured: true,
    features: ['Unlimited employees', 'Full KPI + rewards workflow', 'Attendance & leave module', 'Analytics & PDF/Excel reports', 'AI insights & narratives', 'Priority email support'],
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
  { icon: Zap, title: 'Start with a free trial', desc: 'Sign up and explore all Professional features for 14 days. No credit card required to begin.' },
  { icon: Users, title: 'Pay per active seat', desc: 'You are billed only for active users (employees, managers, admins) each month. Remove seats anytime.' },
  { icon: CreditCard, title: 'Simple monthly billing', desc: 'Invoices are generated on the 1st of each month. Pay by card or bank transfer. Receipts sent automatically.' },
  { icon: TrendingUp, title: 'Scale as you grow', desc: 'Upgrade from Starter to Professional instantly. Add users without contracts — pricing adjusts on your next cycle.' },
  { icon: Award, title: 'No hidden fees', desc: 'Points, reports, attendance, and exports are included. Enterprise adds custom integrations — quoted upfront.' },
];

const MARQUEE_ITEMS = [
  'KPI Tracking', 'Rewards Points', 'Daily Attendance', 'Leave Management',
  'Team Leaderboard', 'PDF Reports', 'AI Insights', 'White-Label Branding',
  'Email Alerts', 'Mobile PWA', 'HR Analytics', 'Manager Approvals',
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
  const revealRef = useReveal();

  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="landing" ref={revealRef}>
      <nav className={`landing-nav ${navScrolled ? 'landing-nav--scrolled' : ''}`}>
        <ScorrWordmark className="landing-nav__logo" />
        <div className="landing-nav__links">
          <a href="#services" onClick={(e) => { e.preventDefault(); scrollTo('services'); }}>Services</a>
          <a href="#how-it-works" onClick={(e) => { e.preventDefault(); scrollTo('how-it-works'); }}>How It Works</a>
          <a href="#pricing" onClick={(e) => { e.preventDefault(); scrollTo('pricing'); }}>Pricing</a>
          <a href="#fees" onClick={(e) => { e.preventDefault(); scrollTo('fees'); }}>Billing</a>
        </div>
        <div className="landing-nav__cta">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => scrollTo('login')}>Sign In</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => scrollTo('login')}>
            Get Started <ArrowRight size={14} />
          </button>
        </div>
      </nav>

      {/* Hero */}
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
              <Sparkles size={14} /> HR Performance Platform
            </div>
            <h1 className="landing-hero__title">
              Elevate your team with <span>Scorr</span>
            </h1>
            <p className="landing-hero__desc">
              The all-in-one platform for KPI tracking, rewards, attendance, and leave — built for admins, managers, and employees. Drive performance with clarity and celebrate wins.
            </p>
            <div className="landing-hero__actions">
              <button type="button" className="btn btn-primary" onClick={() => scrollTo('login')}>
                Start Free Trial <ArrowRight size={16} />
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => scrollTo('pricing')}>
                View Pricing
              </button>
            </div>
            <div className="landing-hero__stats">
              <div>
                <div className="landing-stat__value"><AnimatedCounter target={1000} suffix="+" /></div>
                <div className="landing-stat__label">Max Points / Month</div>
              </div>
              <div>
                <div className="landing-stat__value"><AnimatedCounter target={3} /></div>
                <div className="landing-stat__label">Role Dashboards</div>
              </div>
              <div>
                <div className="landing-stat__value"><AnimatedCounter target={24} suffix="/7" /></div>
                <div className="landing-stat__label">Cloud Access</div>
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
                <CalendarCheck size={18} />
              </div>
              <div className="landing-float-card__title">Attendance Rate</div>
              <div className="landing-float-card__val" style={{ color: '#38bdf8' }}>98%</div>
              <div className="landing-progress"><div className="landing-progress__bar" style={{ width: '98%' }} /></div>
            </div>
          </div>
        </div>
      </section>

      {/* Marquee */}
      <div className="landing-marquee-wrap">
        <div className="landing-marquee">
          {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((item, i) => (
            <span key={i}>{item}</span>
          ))}
        </div>
      </div>

      {/* Services */}
      <section id="services" className="landing-section">
        <div className="landing-section__header landing-reveal">
          <div className="landing-section__eyebrow">What We Offer</div>
          <h2 className="landing-section__title">Everything your HR team needs</h2>
          <p>From task assignment to reward redemption — Scorr connects performance, attendance, and recognition in one beautiful dashboard.</p>
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

      {/* How it works */}
      <section id="how-it-works" className="landing-section landing-section--wide" style={{ background: 'rgba(30,40,56,0.4)' }}>
        <div className="landing-section__header landing-reveal">
          <div className="landing-section__eyebrow">Workflow</div>
          <h2 className="landing-section__title">How Scorr works</h2>
          <p>A simple loop that keeps teams aligned, accountable, and motivated.</p>
        </div>
        <div className="landing-steps" style={{ maxWidth: 1200, margin: '0 auto' }}>
          {[
            { n: 1, title: 'Manager assigns tasks', desc: 'Set KPIs with deadlines and departments for each employee.' },
            { n: 2, title: 'Employee delivers', desc: 'Track progress, check in daily, and mark tasks complete on time.' },
            { n: 3, title: 'Score & reward', desc: 'Monthly scores convert to points. Redeem rewards from the catalog.' },
            { n: 4, title: 'Leadership insights', desc: 'Admins export reports, run analytics, and manage the full org.' },
          ].map((s, i) => (
            <div key={s.n} className={`landing-step landing-reveal landing-reveal--delay-${i + 1}`}>
              <div className="landing-step__num">{s.n}</div>
              <h4>{s.title}</h4>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="landing-section">
        <div className="landing-section__header landing-reveal">
          <div className="landing-section__eyebrow">Pricing</div>
          <h2 className="landing-section__title">Transparent plans for every team</h2>
          <p>Start free, scale when ready. All plans include secure cloud hosting and regular updates.</p>
        </div>
        <div className="landing-pricing">
          {PLANS.map((plan, i) => (
            <div
              key={plan.name}
              className={`landing-price-card landing-reveal landing-reveal--delay-${i + 1} ${plan.featured ? 'landing-price-card--featured' : ''}`}
            >
              {plan.featured && <span className="landing-price-card__badge">Most Popular</span>}
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
              <button type="button" className={`btn ${plan.featured ? 'btn-primary' : 'btn-secondary'}`} style={{ width: '100%' }} onClick={() => scrollTo('login')}>
                {plan.name === 'Enterprise' ? 'Contact Sales' : 'Get Started'}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Fee process */}
      <section id="fees" className="landing-fees">
        <div className="landing-fees__grid">
          <div className="landing-reveal">
            <div className="landing-section__eyebrow">Billing & Fees</div>
            <h2 className="landing-section__title" style={{ textAlign: 'left', marginBottom: '1rem' }}>How our fee process works</h2>
            <p style={{ marginBottom: '1.5rem' }}>
              No surprises. Scorr uses simple per-seat pricing with a free trial so you can evaluate the full platform before committing.
            </p>
            <div style={{ padding: '1.25rem', background: 'var(--bg-card)', borderRadius: 'var(--border-radius-md)', border: '1px solid var(--border-color)' }}>
              <strong style={{ color: 'var(--landing-accent)' }}>Rewards points never expire.</strong>
              <p style={{ fontSize: '0.88rem', marginTop: '0.5rem' }}>
                ≥90% score → 1,000 pts · 80–89% → 500 · 70–79% → 250 · below 70% → 0. Points are included at no extra cost.
              </p>
            </div>
          </div>
          <div>
            {FEE_STEPS.map((step, i) => (
              <div key={step.title} className={`landing-fee-item landing-reveal landing-reveal--delay-${(i % 3) + 1}`}>
                <div className="landing-fee-item__icon"><step.icon size={18} /></div>
                <div>
                  <strong style={{ display: 'block', marginBottom: '0.25rem' }}>{step.title}</strong>
                  <p style={{ fontSize: '0.88rem' }}>{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Login */}
      <section id="login" className="landing-login-section">
        <div className="landing-login-grid">
          <div className="landing-reveal">
            <div className="landing-section__eyebrow">Get Started</div>
            <h2 className="landing-section__title" style={{ textAlign: 'left' }}>Sign in to Scorr</h2>
            <p style={{ marginBottom: '1.5rem' }}>
              Access your dashboard at <strong style={{ color: 'var(--landing-accent)' }}>scorr.walfia.ai</strong>. Use demo accounts below to explore each role instantly.
            </p>
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              {['Employee — KPIs, attendance & rewards', 'Manager — assign tasks, approve leave', 'Admin — users, reports & branding'].map((t) => (
                <li key={t} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  <Check size={16} style={{ color: 'var(--landing-accent)' }} /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="landing-login-card-wrap landing-reveal landing-reveal--delay-2">
            <Login onLoginSuccess={onLoginSuccess} embedded />
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <p>
          © {new Date().getFullYear()} Scorr by <a href="https://walfia.ai" target="_blank" rel="noreferrer">Walfia</a>
          {' · '}
          <a href="https://scorr.walfia.ai">scorr.walfia.ai</a>
        </p>
      </footer>
    </div>
  );
}
