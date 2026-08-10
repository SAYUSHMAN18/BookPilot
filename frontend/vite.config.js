import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Section 13 — builds into ../public/app so server.js can serve the
// compiled SPA as a normal static directory (`express.static`), no
// separate frontend server/process in production. Deliberately additive:
// the existing hand-rolled public/dashboard.html keeps working at
// /dashboard, untouched — this new app lives at /app until it's had a
// real production shakeout, at which point swapping the default is a
// one-line server.js change, not a risky simultaneous rewrite+cutover.
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  build: {
    outDir: "../public/app",
    emptyOutDir: true,
  },
  server: {
    // Dev-mode only: proxies API calls to the real Express server so
    // `npm run dev` here works against real data without CORS headaches.
    proxy: {
      "/api": "http://localhost:8081",
    },
  },
});
