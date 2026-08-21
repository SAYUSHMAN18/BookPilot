// Applies the stored theme choice before React mounts, so a "dark" pick
// doesn't flash light for one frame — see ThemeToggle.jsx, which is the
// only other place that reads/writes this same localStorage key.
try {
  document.documentElement.setAttribute(
    "data-theme",
    localStorage.getItem("bookpilot-theme") === "dark" ? "dark" : "light"
  );
} catch (_e) {
  // localStorage unavailable (private browsing, etc.) — default light stays.
}
