import { render, screen } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import AnimatedNumber from "../AnimatedNumber";

// Found live: requestAnimationFrame is throttled to near-zero in a
// background tab, which left every stat tile using this component stuck
// at its starting value (0) whenever data loaded while the dashboard
// tab wasn't focused — reading as a broken/empty dashboard rather than a
// merely-paused animation. This pins the fix: a hidden document should
// render the real value immediately, not the count-up's starting point.
describe("AnimatedNumber", () => {
  afterEach(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("renders the final value immediately when the document is hidden", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    render(<AnimatedNumber value={42} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("applies the format function to the final value", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    render(<AnimatedNumber value={1500} format={(n) => `₹${n.toLocaleString("en-IN")}`} />);
    expect(screen.getByText("₹1,500")).toBeInTheDocument();
  });

  it("passes through a non-numeric value unchanged", () => {
    render(<AnimatedNumber value="—" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
