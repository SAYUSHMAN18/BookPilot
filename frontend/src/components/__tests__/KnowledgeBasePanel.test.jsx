import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import KnowledgeBasePanel from "../KnowledgeBasePanel";

// New this pass — the document-upload flow (PDF/DOCX/TXT -> extracted
// text -> pre-filled, still-editable entry form) was built and
// live-verified this session but never had automated coverage. Mocks
// fetch by URL since uploadFile() and the plain GET/POST both go through
// the same global fetch.
function mockFetchByUrl(handlers) {
  global.fetch = vi.fn((url, options) => {
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) throw new Error(`Unmocked fetch: ${url}`);
    return Promise.resolve(handlers[key](options));
  });
}
function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe("KnowledgeBasePanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads and lists existing entries", async () => {
    mockFetchByUrl({
      "/api/dashboard/knowledge": () => jsonResponse([{ id: 1, title: "Do you accept insurance?", content: "No, cash or UPI only." }]),
    });
    render(<KnowledgeBasePanel provider={{ workflowId: "salon" }} isAdmin={false} />);
    await waitFor(() => expect(screen.getByText("Do you accept insurance?")).toBeInTheDocument());
  });

  it("uploading a document extracts text and opens a pre-filled, editable entry form", async () => {
    mockFetchByUrl({
      "/api/dashboard/knowledge/extract-document": () => jsonResponse({ title: "hours.pdf", content: "We're open 9am-9pm daily." }),
      "/api/dashboard/knowledge": () => jsonResponse([]),
    });
    render(<KnowledgeBasePanel provider={{ workflowId: "salon" }} isAdmin={false} />);

    const file = new File(["dummy"], "hours.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByDisplayValue("hours.pdf")).toBeInTheDocument());
    const contentBox = screen.getByPlaceholderText(/Content — type it yourself/i);
    expect(contentBox.value).toBe("We're open 9am-9pm daily.");
    // Still editable, not locked in as read-only extracted text.
    fireEvent.change(contentBox, { target: { value: "We're open 9am-9pm daily, closed Sundays." } });
    expect(contentBox.value).toBe("We're open 9am-9pm daily, closed Sundays.");
  });

  it("shows the extraction error instead of silently failing on an unsupported file", async () => {
    mockFetchByUrl({
      "/api/dashboard/knowledge/extract-document": () => jsonResponse({ error: "Unsupported file type." }, false, 400),
      "/api/dashboard/knowledge": () => jsonResponse([]),
    });
    render(<KnowledgeBasePanel provider={{ workflowId: "salon" }} isAdmin={false} />);

    const file = new File(["dummy"], "notes.exe", { type: "application/octet-stream" });
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("Unsupported file type.")).toBeInTheDocument());
  });

  it("requires both title and content before saving", async () => {
    mockFetchByUrl({ "/api/dashboard/knowledge": () => jsonResponse([]) });
    render(<KnowledgeBasePanel provider={{ workflowId: "salon" }} isAdmin={false} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    fireEvent.click(screen.getByText("＋ Add Entry"));
    fireEvent.click(screen.getByText("Save"));
    expect(screen.getByText("Title and content are both required.")).toBeInTheDocument();
  });
});
