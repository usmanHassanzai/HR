import { FUNCTIONAL_DEPARTMENTS, formatWeightPct } from '../utils/departmentHelpers';

/** Reference KPI board — matches the provided department-wise monthly KPI images. */
export default function KpiBoardReferencePanel() {
  return (
    <div className="kpi-board-reference">
      <div className="kpi-board-reference__intro">
        <h3>Department-wise monthly KPI board</h3>
        <p>
          Each department tracks key metrics with <strong>weighted importance</strong>.
          Weightages sum to <strong>100% per department</strong>. Each employee gets their own separate 100% board.
        </p>
        <div className="kpi-board-reference__formula">
          <strong>New departments:</strong> Auto-get same 4 KPI metrics (Performance 30%, Quality 30%, Timeliness 20%, Efficiency 20%).
        </div>
        <div className="kpi-board-reference__formula">
          <strong>Score formula:</strong> (Target achieved %) × (KPI weight %)
        </div>
        <div className="kpi-board-reference__legend">
          <span className="kpi-traffic kpi-traffic--green">Green — on track</span>
          <span className="kpi-traffic kpi-traffic--yellow">Yellow — at risk</span>
          <span className="kpi-traffic kpi-traffic--red">Red — off track</span>
        </div>
      </div>

      <div className="kpi-board-reference__departments">
        {FUNCTIONAL_DEPARTMENTS.map((dept, idx) => (
          <section key={dept.slug} className="kpi-board-reference__dept">
            <h4>
              {idx + 1}. {dept.name}
              <span className="kpi-board-reference__dept-total">Total weight: 100%</span>
            </h4>
            <ul>
              {dept.indicators.map((ind) => (
                <li key={ind.name}>
                  <div className="kpi-board-reference__metric">
                    <strong>{ind.name}</strong>
                    <span className="dept-weight-badge">{formatWeightPct(ind.weight_pct)} weight</span>
                  </div>
                  <p>{ind.description}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
