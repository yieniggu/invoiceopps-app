import { cleanup, render, screen } from "@testing-library/react";
import { FileText } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
  it("titles itself with an h2 by default", () => {
    render(<EmptyState icon={FileText} title="Nada por aquí" />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Nada por aquí" }),
    ).toBeTruthy();
  });

  it("titles itself with an h3 inside a section that already has an h2", () => {
    render(
      <section>
        <h2>Facturas</h2>
        <EmptyState
          icon={FileText}
          title="Elige un propietario"
          headingLevel={3}
        />
      </section>,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "Elige un propietario" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  });
});
