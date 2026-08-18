import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { AuthProvider } from "./lib/AuthContext";
import "./global.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {/* Rendered once at the root (not per-page) so the grain texture sits
        over every screen — login, pending, platform admin, dashboard —
        without each of App.jsx's early-return branches needing to
        remember it. Fixed + pointer-events:none, so it never intercepts
        clicks or shifts layout. */}
    <div className="grain-overlay" aria-hidden="true" />
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>
);
