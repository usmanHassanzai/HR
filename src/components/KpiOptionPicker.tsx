export default function KpiOptionPicker({
  legend,
  options,
  value,
  onChange,
  disabled,
  name,
}: {
  legend: string;
  options: { id: string; label: string; scorePct?: number }[];
  value: string | null | undefined;
  onChange: (id: string) => void;
  disabled?: boolean;
  name: string;
}) {
  return (
    <fieldset className="kpi-option-picker" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="kpi-option-picker__list" role="radiogroup" aria-label={legend}>
        {options.map((opt) => (
          <label key={opt.id} className={`kpi-option-picker__item${value === opt.id ? ' kpi-option-picker__item--on' : ''}`}>
            <input
              type="radio"
              name={name}
              value={opt.id}
              checked={value === opt.id}
              onChange={() => onChange(opt.id)}
              disabled={disabled}
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
