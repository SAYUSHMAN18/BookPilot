// Resolves a pasted Google Maps / share.google link into whatever
// structured data is actually reachable without a paid API or a headless
// browser. Verified live against real share.google links: they redirect
// (via a couple of hops) to a Google SEARCH results URL, not an actual
// Maps place page — and that results page is entirely client-side
// rendered, so fetching it server-side returns no photo, no address, no
// coordinates, nothing usable in the HTML body at all. What IS reliable:
// Google's own redirect carries the place's name as the `q` query param on
// that final search URL — no need to parse the page body for that part.
// A link that happens to resolve straight to an actual Maps place page
// (some do) can also carry coordinates in its path/query, so that's
// checked too, but it won't fire for the common share.google case.
const ALLOWED_HOSTS = new Set([
  "share.google",
  "google.com",
  "www.google.com",
  "maps.google.com",
  "maps.app.goo.gl",
  "goo.gl",
]);

async function resolveMapsLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only https:// links are supported.");
  }
  // Restricted to a known-Google hostname allowlist — this endpoint makes a
  // server-side outbound fetch of whatever URL is passed in, and without
  // this check it would be a straightforward SSRF vector (fetch an
  // internal/private address on the server's behalf).
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error("Only Google Maps or share.google links are supported.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let resp;
  try {
    resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BookPilotAI/1.0; +booking-business-setup)" },
    });
  } catch (err) {
    throw new Error(`Couldn't reach that link: ${err.message}`, { cause: err });
  } finally {
    clearTimeout(timeout);
  }

  const finalUrl = new URL(resp.url);

  let name = null;
  const q = finalUrl.searchParams.get("q");
  if (q) name = q.replace(/\+/g, " ").trim();
  const placeMatch = finalUrl.pathname.match(/\/maps\/place\/([^/]+)/);
  if (!name && placeMatch) name = decodeURIComponent(placeMatch[1]).replace(/\+/g, " ").trim();

  const coordMatch =
    finalUrl.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || finalUrl.href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  const coordinates = coordMatch ? `${coordMatch[1]},${coordMatch[2]}` : null;

  return { name, coordinates, resolvedUrl: finalUrl.href };
}

module.exports = { resolveMapsLink };
