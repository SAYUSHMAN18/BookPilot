// Section 13 — talks to the exact same /api/dashboard/* and /api/auth/*
// routes public/dashboard.html already uses; no backend changes needed
// for this rewrite. Cookie-based session auth (credentials: 'include'),
// same as the vanilla dashboard's own `api()` helper.
export async function api(path, options = {}) {
  const resp = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${resp.status})`);
  }
  return resp.status === 204 ? null : resp.json();
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
export const del = (path) => api(path, { method: "DELETE" });
