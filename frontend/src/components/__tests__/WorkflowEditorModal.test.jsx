import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import WorkflowEditorModal from "../WorkflowEditorModal";

// New this pass — this modal is the core deliverable of this session's
// work (business-aware extra-question suggestions, the base-questions
// summary, provider add/remove) and had zero automated coverage until
// now, relying entirely on live-browser verification. Covers the parts
// most likely to silently regress: the base-questions summary reading
// from the template's own steps, category-matched suggestion chips,
// adding/removing a provider's extra question, and the save validation
// path — not full leaflet/map-picker or AI-generate coverage (those stay
// on live-browser verification, same as before).
describe("WorkflowEditorModal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows what every customer is already asked, derived from the template's own steps", () => {
    render(<WorkflowEditorModal onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/What's your name/i)).toBeInTheDocument();
  });

  it("renders the default provider with its name and fee", () => {
    render(<WorkflowEditorModal onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByDisplayValue("Provider 1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();
  });

  it("adding a provider increases the provider count badge", () => {
    render(<WorkflowEditorModal onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("＋ Add Provider"));
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByDisplayValue("New Provider")).toBeInTheDocument();
  });

  it("suggests salon-relevant extra questions once the business name says so, not a generic default", () => {
    render(<WorkflowEditorModal onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Zen Massage & Spa"), { target: { value: "Rico's Hair Salon" } });
    fireEvent.click(screen.getByText(/Ask this provider's customers something extra/i));
    expect(screen.getByText("＋ What they're in for")).toBeInTheDocument();
    expect(screen.getByText("＋ Stylist preference")).toBeInTheDocument();
    expect(screen.queryByText(/＋ Anything to know/)).not.toBeInTheDocument();
  });

  it("falls back to a generic suggestion when the business doesn't match any known category", () => {
    render(<WorkflowEditorModal onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Zen Massage & Spa"), { target: { value: "Xyzzy Widgets" } });
    fireEvent.click(screen.getByText(/Ask this provider's customers something extra/i));
    expect(screen.getByText("＋ Anything to know")).toBeInTheDocument();
  });

  it("clicking a suggestion chip adds a pre-filled, still-editable extra question", () => {
    render(<WorkflowEditorModal onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Zen Massage & Spa"), { target: { value: "Downtown Salon" } });
    fireEvent.click(screen.getByText(/Ask this provider's customers something extra/i));
    fireEvent.click(screen.getByText("＋ What they're in for"));

    expect(screen.getByDisplayValue("What they're in for")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/haircut, beard trim, coloring/)).toBeInTheDocument();

    // Collapse the panel — the toggle should now report the count instead
    // of the generic "add one" invite.
    fireEvent.click(screen.getByText("Hide extra questions"));
    expect(screen.getByText("Extra questions (1)")).toBeInTheDocument();
  });

  it("removing an added extra question takes it back to zero", () => {
    render(<WorkflowEditorModal onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Zen Massage & Spa"), { target: { value: "Downtown Salon" } });
    fireEvent.click(screen.getByText(/Ask this provider's customers something extra/i));
    fireEvent.click(screen.getByText("＋ Write your own"));
    expect(screen.getByTitle("Remove question")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Remove question"));
    fireEvent.click(screen.getByText("Hide extra questions"));
    expect(screen.getByText(/Ask this provider's customers something extra/i)).toBeInTheDocument();
  });

  it("blocks saving without a business name instead of silently posting", () => {
    render(<WorkflowEditorModal onClose={() => {}} onSaved={() => {}} />);
    global.fetch = vi.fn();
    fireEvent.click(screen.getByText("Save Business"));
    expect(screen.getByText("Business Name is required.")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("saves a valid new business and normalizes the fee to a number", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const onSaved = vi.fn();
    render(<WorkflowEditorModal onClose={() => {}} onSaved={onSaved} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Zen Massage & Spa"), { target: { value: "Rico's Hair Salon" } });
    fireEvent.click(screen.getByText("Save Business"));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.label).toBe("Rico's Hair Salon");
    expect(body.id).toBe("rico-s-hair-salon");
    expect(body.providers[0].fee).toBe(100);
    expect(typeof body.providers[0].fee).toBe("number");
  });
});
