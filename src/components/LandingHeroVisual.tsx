import { BarChart3, Trophy, KeyRound } from 'lucide-react';

/** Decorative float cards for the landing hero — loaded after first paint. */
export default function LandingHeroVisual() {
  return (
    <>
      <div className="landing-float-card landing-float-card--1">
        <div className="landing-float-card__icon" style={{ background: 'rgba(45,212,168,0.15)', color: '#2dd4a8' }}>
          <BarChart3 size={18} />
        </div>
        <div className="landing-float-card__title">Weightage</div>
        <div className="landing-float-card__val" style={{ color: '#2dd4a8' }}>80%</div>
        <div className="landing-progress"><div className="landing-progress__bar" style={{ width: '80%' }} /></div>
      </div>
      <div className="landing-float-card landing-float-card--2">
        <div className="landing-float-card__icon" style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
          <Trophy size={18} />
        </div>
        <div className="landing-float-card__title">Score index</div>
        <div className="landing-float-card__val" style={{ color: '#fbbf24' }}>218.75</div>
        <div className="landing-progress"><div className="landing-progress__bar" style={{ width: '100%' }} /></div>
      </div>
      <div className="landing-float-card landing-float-card--3">
        <div className="landing-float-card__icon" style={{ background: 'rgba(13,148,136,0.15)', color: '#0d9488' }}>
          <KeyRound size={18} />
        </div>
        <div className="landing-float-card__title">MFA ready</div>
        <div className="landing-float-card__val" style={{ color: '#0d9488' }}>Secure</div>
        <div className="landing-progress"><div className="landing-progress__bar" style={{ width: '100%' }} /></div>
      </div>
    </>
  );
}
