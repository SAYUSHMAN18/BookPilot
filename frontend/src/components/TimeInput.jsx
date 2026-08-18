import { useEffect, useRef, useState } from "react";

// Replaces a bare <input type="time"> — found live: the native time
// widget's own picker (a scroll-wheel on some browsers, tiny stepper
// arrows on others) is inconsistent across browsers and generally felt
// clunky. This keeps the exact same underlying value format (24h "HH:MM",
// what the backend already stores and expects — see availabilityStore.js)
// but adds a consistently-styled, actually-scrollable dropdown of common
// times, while still accepting direct typing at any moment: the dropdown
// is a shortcut, never the only way in.
const TIME_OPTIONS = (() => {
  const opts = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const hh = String(h).padStart(2, "0");
      const mm = String(m).padStart(2, "0");
      const value = `${hh}:${mm}`;
      const period = h < 12 ? "AM" : "PM";
      const h12 = h % 12 === 0 ? 12 : h % 12;
      opts.push({ value, label: `${h12}:${mm} ${period}` });
    }
  }
  return opts;
})();

function formatDisplay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!match) return value || "";
  const h = Number(match[1]);
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${match[2]} ${period}`;
}

export default function TimeInput({ value, onChange, placeholder, title }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(formatDisplay(value));
  const wrapRef = useRef(null);

  useEffect(() => { setText(formatDisplay(value)); }, [value]);

  useEffect(() => {
    if (!open) return;
    function onOutside(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  // Accepts "9", "9:30", "9:30 am", "21:30" — anything a person would
  // actually type — and normalizes it to the stored 24h "HH:MM" on blur,
  // rather than fighting the keystroke-by-keystroke input while it's
  // still mid-edit (e.g. "1" alone isn't valid yet, but shouldn't be
  // rejected outright).
  function parseTyped(raw) {
    const s = raw.trim().toLowerCase();
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
    if (!m) return null;
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (min > 59) return null;
    const period = m[3];
    if (period) {
      if (h < 1 || h > 12) return null;
      if (period === "am") h = h === 12 ? 0 : h;
      else h = h === 12 ? 12 : h + 12;
    } else if (h > 23) {
      return null;
    }
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  function commitTyped() {
    if (!text.trim()) { onChange(""); return; }
    const parsed = parseTyped(text);
    if (parsed) onChange(parsed);
    else setText(formatDisplay(value)); // couldn't make sense of it — revert rather than save garbage
  }

  return (
    <div className="time-input" ref={wrapRef}>
      <input
        className="form-input"
        type="text"
        placeholder={placeholder}
        title={title}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={commitTyped}
        onKeyDown={(e) => { if (e.key === "Enter") { commitTyped(); setOpen(false); e.currentTarget.blur(); } if (e.key === "Escape") setOpen(false); }}
      />
      {open && (
        <div className="time-input-dropdown" onMouseDown={(e) => e.preventDefault()}>
          {TIME_OPTIONS.map((o) => (
            <button
              type="button"
              key={o.value}
              className={"time-input-option" + (o.value === value ? " selected" : "")}
              onClick={() => { onChange(o.value); setText(o.label); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
