import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import AnalyticsPanel from "../AnalyticsPanel";

// New this pass — the CSV export button had no coverage. jsdom has no
// real Blob/URL.createObjectURL implementation, so this stubs just enough
// of it to prove exportCsv() builds a well-formed CSV and doesn't throw,
// without asserting on browser download mechanics vitest can't provide.
describe("AnalyticsPanel CSV export", () => {
  let createdBlobs;

  beforeEach(() => {
    createdBlobs = [];
    global.URL.createObjectURL = vi.fn((blob) => { createdBlobs.push(blob); return "blob:mock"; });
    global.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is disabled when there's no data yet", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ total: 0, responseTime: {}, popularSlots: [], weekdayCounts: [0, 0, 0, 0, 0, 0, 0], noShowRate: null, avgRating: null, paidBookingCount: 0, revenue: 0 }),
    });
    render(<AnalyticsPanel refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/No bookings yet/i)).toBeInTheDocument());
    expect(screen.getByText("⬇ Export CSV")).toBeDisabled();
  });

  it("builds a CSV containing the visible metrics when clicked", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        total: 12, responseTime: { p50: 900, p95: 1500, max: 2000, sampleSize: 12 },
        popularSlots: [{ time: "10:00", count: 5 }], weekdayCounts: [1, 2, 3, 2, 1, 2, 1],
        noShowRate: 8, noShowSampleSize: 12, avgRating: 4.5, ratingSampleSize: 6,
        paidBookingCount: 9, revenue: 4500, providers: [{ workflowId: "salon", providerId: "p1", providerName: "Asha", total: 6, arrived: 5, cancelled: 1 }],
      }),
    });
    render(<AnalyticsPanel refreshKey={0} />);
    await waitFor(() => expect(screen.getByText("⬇ Export CSV")).not.toBeDisabled());

    fireEvent.click(screen.getByText("⬇ Export CSV"));
    expect(createdBlobs).toHaveLength(1);
    const text = await createdBlobs[0].text();
    expect(text).toContain("No-show rate");
    expect(text).toContain("8% of 12");
    expect(text).toContain("Average rating");
    expect(text).toContain("Asha");
  });
});
