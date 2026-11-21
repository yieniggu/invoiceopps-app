import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NO_PERMISSIONS } from "../types";
import {
  DeployModelsIndicator,
  PermissionRatio,
} from "./DeployModelsIndicator";

afterEach(cleanup);

describe("DeployModelsIndicator", () => {
  it("names the flag when it is on and draws nothing when it is off", () => {
    const { rerender } = render(
      <DeployModelsIndicator
        permissions={{ ...NO_PERMISSIONS, deployModels: true }}
      />,
    );
    expect(screen.getByRole("img", { name: "Despliega modelos" })).toBeTruthy();
    rerender(<DeployModelsIndicator permissions={NO_PERMISSIONS} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("adds the indicator to the invoice ratio, which never counts the model flag", () => {
    const permissions = {
      ...NO_PERMISSIONS,
      readInvoices: true,
      deployModels: true,
    };
    const { container } = render(<PermissionRatio permissions={permissions} />);
    expect(container.textContent).toBe("1 de 4 permisos");
    expect(screen.getByRole("img", { name: "Despliega modelos" })).toBeTruthy();
  });
});
