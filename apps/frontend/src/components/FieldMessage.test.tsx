import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FieldMessage } from "./FieldMessage";

afterEach(cleanup);

describe("FieldMessage", () => {
  it("renders no selector attributes unless they are given", () => {
    render(<FieldMessage id="msg" text="Falta" />);
    const message = screen.getByText("Falta");
    expect(message.id).toBe("msg");
    expect(message.hasAttribute("data-field")).toBe(false);
    expect(message.hasAttribute("data-testid")).toBe(false);
  });

  it("carries data-field and data-testid when given", () => {
    render(<FieldMessage id="msg" field="amount" testId="amount-error" />);
    const message = screen.getByTestId("amount-error");
    expect(message.getAttribute("data-field")).toBe("amount");
    expect(message.textContent).toBe("");
  });
});
