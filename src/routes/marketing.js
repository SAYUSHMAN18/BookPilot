const path = require("path");
const express = require("express");

const router = express.Router();

// Public marketing site (public/marketing/) — plain HTML/CSS/JS, no build
// step. This is what "/" serves; the JSON health check lives at /health.
router.use("/marketing", express.static(path.join(__dirname, "..", "..", "public", "marketing")));
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "marketing", "index.html"));
});
router.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "marketing", "signup.html"));
});
router.get("/plan-selection", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "marketing", "plan-selection.html"));
});

// SEO basics — neither existed. Generated from the actual request's own
// host (req.protocol + req.get("host")) rather than a hardcoded domain
// baked into a static file, so this is automatically correct on
// localhost during development, a Render/Railway preview URL, and
// whatever the real production domain ends up being, with no per-
// environment config needed. Just the handful of real, indexable pages —
// /app, /api/*, and everything behind a login obviously shouldn't be
// crawled (and mostly live on a different origin/port anyway, per this
// file's own split-marketing-from-dashboard comment above), so there's
// nothing to Disallow that a crawler would ever reach from here regardless.
router.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    "User-agent: *\n" +
    "Allow: /\n" +
    "\n" +
    `Sitemap: ${req.protocol}://${req.get("host")}/sitemap.xml\n`
  );
});
router.get("/sitemap.xml", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const pages = [
    { path: "/", priority: "1.0" },
    { path: "/signup", priority: "0.8" },
  ];
  const urls = pages
    .map((p) => `  <url>\n    <loc>${base}${p.path}</loc>\n    <priority>${p.priority}</priority>\n  </url>`)
    .join("\n");
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
});

module.exports = { router };
