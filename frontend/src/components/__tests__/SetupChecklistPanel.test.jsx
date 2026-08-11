import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import SetupChecklistPanel from "../SetupChecklistPanel";

describe("SetupChecklistPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all four checklist items with their done state", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { id: "customize-business", label: "Customize your first business", done: true, hint: "hint 1" },
          { id: "connect-whatsapp", label: "Connect your WhatsApp number", done: false, hint: "hint 2" },
          { id: "invite-team", label: "Invite your team", done: false, hint: "hint 3" },
          { id: "first-booking", label: "Get your first booking", done: false, hint: "hint 4" },
        ],
        allDone: false,
        dismissed: false,
      }),
    });

    render(<SetupChecklistPanel refreshKey={0} />);

    await waitFor(() => expect(screen.getByText(/Getting Started/i)).toBeInTheDocument());
    expect(screen.getByText("1 of 4")).toBeInTheDocument();
    expect(screen.getByText("Customize your first business")).toBeInTheDocument();
    expect(screen.getByText("Connect your WhatsApp number")).toBeInTheDocument();
  });

  it("renders nothing once dismissed", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [], allDone: true, dismissed: true }),
    });

    const { container } = render(<SetupChecklistPanel refreshKey={0} />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("calls the dismiss endpoint when \"Hide for now\" is clicked", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url === "/api/dashboard/setup-checklist/dismiss") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ items: [{ id: "x", label: "X", done: false, hint: "h" }], allDone: false, dismissed: false }),
      });
    });

    render(<SetupChecklistPanel refreshKey={0} />);
    await waitFor(() => expect(screen.getByText("Hide for now")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Hide for now"));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      "/api/dashboard/setup-checklist/dismiss",
      expect.objectContaining({ method: "POST" })
    ));
  });
});
