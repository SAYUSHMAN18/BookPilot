// Self-audit finding: LoginPage — the actual front door of the dashboard,
// and one of the highest-traffic pages in the app — had zero test coverage
// before this. Covers the two real user flows: signing in (success and
// failure) and the "forgot password" sub-flow, against a stubbed fetch
// (same pattern every other frontend test in this suite already uses).
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import LoginPage from "../LoginPage";
import { AuthProvider } from "../../lib/AuthContext";

function renderLoginPage() {
  return render(
    <AuthProvider>
      <LoginPage />
    </AuthProvider>
  );
}

// AuthProvider's own mount-time checkSession() always fires a GET
// /api/auth/me first — every test's fetch stub has to handle that call
// (as "not logged in") in addition to whatever that specific test is
// actually exercising, or the real request this page makes gets a
// leftover mock response meant for a different endpoint.
function stubFetch(handlers) {
  global.fetch = vi.fn(async (url, opts) => {
    if (typeof url === "string" && url.includes("/api/auth/me")) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    for (const [match, handler] of handlers) {
      if (typeof url === "string" && url.includes(match)) return handler(opts);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
}

describe("LoginPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits credentials and sends them to /api/auth/login", async () => {
    stubFetch([["/api/auth/login", async () => ({ ok: true, status: 200, json: async () => ({ user: { email: "a@b.com" } }) })]]);

    renderLoginPage();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      const loginCall = global.fetch.mock.calls.find(([url]) => typeof url === "string" && url.includes("/api/auth/login"));
      expect(loginCall).toBeTruthy();
    });
    const loginCall = global.fetch.mock.calls.find(([url]) => typeof url === "string" && url.includes("/api/auth/login"));
    expect(JSON.parse(loginCall[1].body)).toEqual({ email: "a@b.com", password: "hunter2" });
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });

  it("shows the server's error message when login fails", async () => {
    stubFetch([["/api/auth/login", async () => ({ ok: false, status: 401, json: async () => ({ error: "Invalid email or password." }) })]]);

    renderLoginPage();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Invalid email or password.")).toBeInTheDocument());
  });

  it("'Forgot password?' switches to the reset form and submitting it shows the confirmation message", async () => {
    stubFetch([
      [
        "/api/auth/forgot-password",
        async () => ({ ok: true, status: 200, json: async () => ({ message: "If an account exists for that email, a reset link has been sent." }) }),
      ],
    ]);

    renderLoginPage();
    fireEvent.click(screen.getByText("Forgot password?"));
    expect(screen.getByText("Reset your password")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() => expect(screen.getByText("If an account exists for that email, a reset link has been sent.")).toBeInTheDocument());
  });

  it("'Back to login' returns from the reset form to the sign-in form", async () => {
    stubFetch([]);

    renderLoginPage();
    fireEvent.click(screen.getByText("Forgot password?"));
    expect(screen.getByText("Reset your password")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Back to login"));
    expect(screen.getByText("Sign in to your dashboard")).toBeInTheDocument();
  });
});
