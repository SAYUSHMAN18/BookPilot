import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds into ../public/app so server.js can serve the compiled SPA as a
// normal static directory (`express.static`), no separate frontend
// server/process in production. This is the only dashboard now — the old
// hand-rolled public/dashboard.html reached parity and was deleted; /dashboard
// just redirects here.
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
