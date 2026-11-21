import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NO_PERMISSIONS, type InvoicePermissions } from "../types";
import { MemberPermissionsEditor } from "./MemberPermissionsEditor";

afterEach(cleanup);

function setup(value: InvoicePermissions) {
  const onChange = vi.fn();
  render(
    <MemberPermissionsEditor
      memberName="Ada"
      level="organization"
      value={value}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("«Marcar todos» and «Desmarcar todos» (CR-550)", () => {
  it("marks the four invoice flags and leaves deployModels on", () => {
    const onChange = setup({ ...NO_PERMISSIONS, deployModels: true });
    fireEvent.click(screen.getByRole("button", { name: "Marcar todos" }));
    expect(onChange).toHaveBeenCalledWith({
      readInvoices: true,
      createInvoices: true,
      deleteOwnInvoices: true,
      deleteOthersInvoices: true,
      deployModels: true,
    });
  });

  it("marks the four invoice flags and leaves deployModels off", () => {
    const onChange = setup(NO_PERMISSIONS);
    fireEvent.click(screen.getByRole("button", { name: "Marcar todos" }));
    expect(onChange.mock.calls[0]![0].deployModels).toBe(false);
  });

  it("clears the invoice flags and keeps deployModels as it was", () => {
    const onChange = setup({
      readInvoices: true,
      createInvoices: true,
      deleteOwnInvoices: true,
      deleteOthersInvoices: true,
      deployModels: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Desmarcar todos" }));
    expect(onChange).toHaveBeenCalledWith({
      ...NO_PERMISSIONS,
      deployModels: true,
    });
  });
});
