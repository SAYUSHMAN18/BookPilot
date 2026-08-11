import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import SessionsPanel from "../SessionsPanel";

describe("SessionsPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders each session and marks the current one, without a Log out button for it", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        { id: "sid-1", userAgent: "Chrome on Mac", createdAt: 1786000000000, expiresAt: 1786100000000, isCurrent: true },
        { id: "sid-2", userAgent: "Safari on iPhone", createdAt: 1786000000000, expiresAt: 1786100000000, isCurrent: false },
      ]),
    });

    render(<SessionsPanel refreshKey={0} />);

    await waitFor(() => expect(screen.getByText("Chrome on Mac")).toBeInTheDocument());
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    // Exactly one "Log out" button — only for the non-current session.
    expect(screen.getAllByText("Log out").length).toBe(1);
  });
});
