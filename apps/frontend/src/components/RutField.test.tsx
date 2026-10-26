import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { RutField } from "./RutField";

afterEach(cleanup);

function Harness({ submitted = false }: { submitted?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <RutField
      ariaLabel="RUT de prueba"
      value={value}
      onChange={setValue}
      submitted={submitted}
    />
  );
}

const input = () =>
  screen.getByRole("textbox", {
    name: "RUT de prueba",
  }) as HTMLInputElement;

describe("RutField", () => {
  it("has no maxLength and normalizes a pasted value with spaces", () => {
    render(<Harness />);
    expect(input().hasAttribute("maxlength")).toBe(false);
    fireEvent.change(input(), { target: { value: " 19.034.790-7 " } });
    expect(input().value).toBe("19.034.790-7");
  });

  it("caps pasted input at the significant characters", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "  190347907 8888 " } });
    expect(input().value).toBe("19.034.790-7");
  });

  it("shows the error only after blur for an invalid RUT", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "190347908" } });
    expect(screen.queryByText("RUT inválido")).toBeNull();
    fireEvent.blur(input());
    const error = screen.getByText("RUT inválido");
    expect(error.getAttribute("role")).toBe("alert");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe(error.id);
  });

  it("shows no error after blur for a valid RUT", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "190347907" } });
    fireEvent.blur(input());
    expect(screen.queryByText("RUT inválido")).toBeNull();
    expect(input().getAttribute("aria-invalid")).toBe("false");
  });

  it("shows no error for an empty value after blur", () => {
    render(<Harness />);
    fireEvent.blur(input());
    expect(screen.queryByText("RUT inválido")).toBeNull();
  });

  it("reports the error after a submit attempt without blur", () => {
    render(<Harness submitted />);
    fireEvent.change(input(), { target: { value: "190347908" } });
    expect(screen.getByText("RUT inválido")).toBeTruthy();
  });
});
