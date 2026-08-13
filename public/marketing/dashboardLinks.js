// Rewrites every "Log in" link (still marked up as the pre-split
// same-origin `href="/app"`, kept as a same-origin fallback for the rare
// case this script or /marketing/config.js fails to load) to point at the
// dashboard server's real URL — see marketingServer.js's own comment on
// why that's not simply hardcoded here. Must load AFTER config.js sets
// window.DASHBOARD_URL and BEFORE nothing in particular — link clicks are
// the only thing that cares, so even a slightly-late run is harmless.
(() => {
  const dashboardUrl = window.DASHBOARD_URL;
  if (!dashboardUrl) return; // config.js failed to load — links keep their same-origin fallback
  document.querySelectorAll('a[href="/app"]').forEach((a) => {
    a.href = `${dashboardUrl}/app`;
  });
})();
