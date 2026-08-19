// Shared across every marketing page (index, signup, plan-selection) —
// one file so the toggle's behavior and storage key can't drift between
// pages. Split into two halves on purpose:
//   1. Runs immediately at the top level, before the DOM is ready — sets
//      data-theme on <html> as early as possible so a stored "dark"
//      choice doesn't flash light for a frame while the rest of the page
//      loads. Works even in <head>, since it only touches the <html>
//      element itself, not page content.
//   2. Wires up any .theme-toggle-btn on the page once the DOM is ready —
//      a page doesn't have to have one (this script is loaded everywhere
//      for consistency, but only pages with the button in their markup
//      get a working switch).
const THEME_KEY = "bookpilot-theme";

function currentTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch (e) {
    return "light";
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

applyTheme(currentTheme());

document.addEventListener("DOMContentLoaded", () => {
  const buttons = document.querySelectorAll(".theme-toggle-btn");
  if (!buttons.length) return;

  function render() {
    const theme = currentTheme();
    buttons.forEach((btn) => {
      const icon = btn.querySelector(".theme-toggle-icon");
      const text = btn.querySelector(".theme-toggle-text");
      if (icon) icon.textContent = theme === "dark" ? "🌙" : "☀️";
      if (text) text.textContent = theme === "dark" ? "Dark mode" : "Light mode";
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      render();
    });
  });

  render();
});
