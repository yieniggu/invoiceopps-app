import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("application shell", () => {
  it("renders an accessible base shell", () => {
    render(<App />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Base de la aplicación preparada",
    });

    expect(heading).toBeTruthy();
    expect(
      screen.getByRole("main", {
        name: "Base de la aplicación preparada",
      }),
    ).toBeTruthy();
  });
});
