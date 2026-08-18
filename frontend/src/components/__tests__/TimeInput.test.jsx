import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import TimeInput from "../TimeInput";

// New this pass — replaced the native <input type="time"> across
// AvailabilityPanel with zero coverage until now. Covers the two things
// that actually matter here: the stored value stays 24h "HH:MM" no
// matter how it was typed, and unparseable input reverts instead of
// silently saving garbage into availability data.
describe("TimeInput", () => {
  it("displays the stored 24h value in 12h format", () => {
    render(<TimeInput value="14:30" onChange={() => {}} />);
    expect(screen.getByDisplayValue("2:30 PM")).toBeInTheDocument();
  });

  it("commits a bare hour like '9' as 09:00 on blur", () => {
    const onChange = vi.fn();
    render(<TimeInput value="" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("09:00");
  });

  it("commits '9:30 am' correctly", () => {
    const onChange = vi.fn();
    render(<TimeInput value="" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "9:30 am" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("09:30");
  });

  it("commits a 24h-style typed value like '21:30' unchanged", () => {
    const onChange = vi.fn();
    render(<TimeInput value="" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "21:30" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("21:30");
  });

  it("reverts to the last valid value instead of saving unparseable input", () => {
    const onChange = vi.fn();
    render(<TimeInput value="10:00" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "not a time" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("10:00 AM");
  });

  it("opens a dropdown of time options on focus and selects one", () => {
    const onChange = vi.fn();
    render(<TimeInput value="" onChange={onChange} />);
    fireEvent.focus(screen.getByRole("textbox"));
    fireEvent.click(screen.getByText("6:00 PM"));
    expect(onChange).toHaveBeenCalledWith("18:00");
  });
});
