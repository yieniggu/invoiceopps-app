import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
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

// jsdom does no layout, so the layout contract is read from the stylesheet: the
// main area is always a flex column, and a `.screen-fill` child simply grows,
// with no `:has()` rule that depends on what else the screen renders.
describe("screen-fill layout", () => {
  const styles = readFileSync("src/styles.css", "utf8");

  it("makes main a flex column and lets .screen-fill grow without :has()", () => {
    expect(styles).toMatch(
      /\.app-shell main\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/,
    );
    expect(styles).toMatch(/\.screen-fill\s*\{[^}]*flex:\s*1 1 auto/);
    expect(styles).not.toMatch(/main:has\(/);
  });

  it("keeps the pagination at the bottom of a filled screen", () => {
    expect(styles).toMatch(
      /\.screen-fill > \.pagination\s*\{[^}]*margin-block-start:\s*auto/,
    );
  });
});
