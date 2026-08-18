// A number input flanked by -/+ buttons — free typing still works exactly
// like a plain <input type="number">, the buttons are purely an added
// convenience for nudging a value up/down without relying on the browser's
// own (inconsistent across Chrome/Firefox/Safari, tiny-target-on-touch)
// native spinner chrome. Used for fee entry today; written generically
// enough (min/step/prefix are all props) to reuse for any other numeric
// field later.
export default function NumberStepperInput({ value, onChange, step = 10, min = 0, prefix, placeholder }) {
  const numeric = typeof value === "number" ? value : Number(value) || 0;

  function nudge(delta) {
    const next = Math.max(min, numeric + delta);
    onChange(next);
  }

  return (
    <div className="number-stepper">
      {prefix && <span className="number-stepper-prefix">{prefix}</span>}
      <button type="button" className="number-stepper-btn" onClick={() => nudge(-step)} aria-label="Decrease">−</button>
      <input
        className="number-stepper-input"
        type="number"
        min={min}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      />
      <button type="button" className="number-stepper-btn" onClick={() => nudge(step)} aria-label="Increase">+</button>
    </div>
  );
}
