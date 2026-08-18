import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import NumberStepperInput from "../NumberStepperInput";

// New this pass — this component previously had zero coverage despite
// replacing the fee input across the whole provider-adding flow. Covers
// the stepper buttons, the min clamp, and free typing (including the
// "cleared to empty string mid-edit" state the fee-save normalization
// in WorkflowEditorModal depends on).
describe("NumberStepperInput", () => {
  it("renders the prefix and the current value", () => {
    render(<NumberStepperInput value={500} onChange={() => {}} prefix="₹" />);
    expect(screen.getByText("₹")).toBeInTheDocument();
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();
  });

  it("increases by `step` when the + button is clicked", () => {
    const onChange = vi.fn();
    render(<NumberStepperInput value={500} onChange={onChange} step={50} />);
    fireEvent.click(screen.getByLabelText("Increase"));
    expect(onChange).toHaveBeenCalledWith(550);
  });

  it("decreases by `step` when the − button is clicked", () => {
    const onChange = vi.fn();
    render(<NumberStepperInput value={500} onChange={onChange} step={50} />);
    fireEvent.click(screen.getByLabelText("Decrease"));
    expect(onChange).toHaveBeenCalledWith(450);
  });

  it("never nudges below `min`", () => {
    const onChange = vi.fn();
    render(<NumberStepperInput value={20} onChange={onChange} step={50} min={0} />);
    fireEvent.click(screen.getByLabelText("Decrease"));
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it("passes typed numeric input straight through as a number", () => {
    const onChange = vi.fn();
    render(<NumberStepperInput value={500} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue("500"), { target: { value: "1200" } });
    expect(onChange).toHaveBeenCalledWith(1200);
  });

  it("allows clearing the field to an empty string instead of forcing 0", () => {
    const onChange = vi.fn();
    render(<NumberStepperInput value={500} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue("500"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });
});
