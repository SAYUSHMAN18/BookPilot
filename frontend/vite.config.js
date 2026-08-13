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
      "/app-config.js": "http://localhost:8081",
    },
  },
  // New plan, Block 6 — vitest reads its own config from this same file
  // (no separate vitest.config.js) rather than duplicating the plugins/
  // build setup above. jsdom gives these smoke tests a real DOM to
  // render into without a browser; setupFiles wires in jest-dom's
  // matchers (toBeInTheDocument(), etc.) globally so individual test
  // files don't each need their own import for that.
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.js"],
    globals: true,
    // Vitest's default "forks" pool spawns real child processes for test
    // isolation — found live to just hang/timeout in this project's
    // sandboxed dev environment (process spawning restricted). "threads"
    // (worker_threads, no new OS process) gives the same test isolation
    // and passes everywhere forks would, without depending on child-
    // process spawning being allowed.
    pool: "threads",
  },
});
