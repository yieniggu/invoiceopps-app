import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { QueryFeedback } from "./QueryFeedback";
import { Skeleton } from "./Skeleton";

afterEach(cleanup);

describe("Skeleton accessible announcement (CR-583)", () => {
  it("announces what loads in a hidden status outside the busy container, without an ellipsis", () => {
    render(<Skeleton rows={2} label="Cargando despliegues" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Cargando despliegues");
    expect(status.className).toContain("visually-hidden");
    expect(status.textContent).not.toMatch(/\.\.\.|…/);
    const busy = screen.getByTestId("skeleton");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.contains(status)).toBe(false);
  });

  it("always renders a non-empty status for the label it requires (CR-587)", () => {
    render(<Skeleton label="Cargando grupos" />);
    expect(screen.getByRole("status").textContent).toBe("Cargando grupos");
  });
});

describe("QueryFeedback loading announcement (CR-583)", () => {
  const query = (
    overrides: Partial<Parameters<typeof QueryFeedback>[0]["query"]>,
  ) => ({
    isPending: true,
    isError: false,
    data: undefined,
    refetch: () => Promise.resolve(),
    ...overrides,
  });

  it("passes the label to the initial-load skeleton only", () => {
    const { rerender } = render(
      <QueryFeedback
        query={query({})}
        skeleton={3}
        loadingLabel="Cargando modelos"
        error="x"
        retryLabel="Reintentar"
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Cargando modelos");
    // A background refresh has data on screen: no skeleton, no announcement.
    rerender(
      <QueryFeedback
        query={query({ isPending: false, data: {} })}
        skeleton={3}
        loadingLabel="Cargando modelos"
        error="x"
        retryLabel="Reintentar"
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });
});

describe("typed loading label requirement (CR-587)", () => {
  it("rejects a skeleton without a label at compile time", () => {
    const unlabeled = () => (
      <>
        {/* @ts-expect-error a Skeleton needs a label */}
        <Skeleton rows={2} />
        {/* @ts-expect-error a QueryFeedback skeleton needs a loadingLabel */}
        <QueryFeedback
          query={{
            isPending: true,
            isError: false,
            data: undefined,
            refetch: async () => undefined,
          }}
          skeleton={3}
          error="x"
          retryLabel="y"
        />
      </>
    );
    expect(typeof unlabeled).toBe("function");
  });
});
