/** Quiet product panel for the landing hero. */
export default function LandingHeroVisual() {
  return (
    <div className="landing-panel" aria-hidden>
      <div className="landing-panel__top">
        <span className="landing-panel__dots" aria-hidden>
          <i /><i /><i />
        </span>
        <span>November · Score weightage</span>
      </div>
      <div className="landing-panel__scores">
        <div>
          <span>Score</span>
          <strong>92.4</strong>
        </div>
        <div>
          <span>Bonus</span>
          <strong>12%</strong>
        </div>
        <div>
          <span>Left to use</span>
          <strong>70</strong>
        </div>
      </div>
      <div className="landing-panel__mix" aria-hidden>
        <span style={{ width: '70%' }} />
      </div>
      <ul className="landing-panel__rows">
        <li><span>Individual KPIs</span><b>70.0</b></li>
        <li><span>Team points</span><b>22.4</b></li>
        <li><span>Attendance</span><b>In office</b></li>
      </ul>
    </div>
  );
}
