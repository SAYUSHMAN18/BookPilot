import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import BillingPanel from "../BillingPanel";

// New plan, Block 6 — a basic smoke test: does this panel render real
// data from a real (mocked) API response without throwing, and show the
// numbers it was given. Not exhaustive coverage of every branch — the
// live-browser verification already done for this component this
// session covers the rest; this is the regression net for "did an
// unrelated change silently break the happy path."
describe("BillingPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the plan name and usage once the API responds", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        plan: "free", planLabel: "Starter", bookingsThisMonth: 12, limit: 100, percentUsed: 12, softLimitExceeded: false,
      }),
    });

    render(<BillingPanel refreshKey={0} />);

    await waitFor(() => expect(screen.getByText(/Starter plan/i)).toBeInTheDocument());
    expect(screen.getByText(/12 bookings this month/i)).toBeInTheDocument();
    expect(screen.queryByText(/reached your/i)).not.toBeInTheDocument();
  });

  it("shows the soft-limit warning banner once the limit is reached", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        plan: "free", planLabel: "Starter", bookingsThisMonth: 100, limit: 100, percentUsed: 100, softLimitExceeded: true,
      }),
    });

    render(<BillingPanel refreshKey={0} />);

    await waitFor(() => expect(screen.getByText(/reached your Starter plan's limit/i)).toBeInTheDocument());
  });

  it("shows an error banner if the API call fails, instead of crashing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal server error." }),
    });

    render(<BillingPanel refreshKey={0} />);

    await waitFor(() => expect(screen.getByText("Internal server error.")).toBeInTheDocument());
  });
});
