import { useEffect, useState } from "react";

// Requested directly: a real dark/light toggle for the dashboard, "below
// at the bottom" — placed as the last item in the sidebar footer.
// `light` is the explicit stored default (not read from the OS's
// prefers-color-scheme) so a first-time visitor sees the dashboard's
// existing, already-shipped look unless they deliberately opt into dark —
// see global.css's :root[data-theme="dark"] block for the actual palette.
const STORAGE_KEY = "bookpilot-theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return stored === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  function toggle() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <button type="button" className="theme-toggle" onClick={toggle} title="Switch theme" aria-label="Switch between light and dark theme">
      <span className={"theme-toggle-track" + (theme === "dark" ? " is-dark" : "")}>
        <span className="theme-toggle-thumb">{theme === "dark" ? "🌙" : "☀️"}</span>
      </span>
      <span className="theme-toggle-label">{theme === "dark" ? "Dark" : "Light"} mode</span>
    </button>
  );
}
