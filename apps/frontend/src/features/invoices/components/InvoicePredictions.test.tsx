import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InvoicePrediction } from "../types";
import { InvoicePredictions, rejectionPercent } from "./InvoicePredictions";

afterEach(cleanup);

const prediction = (
  n: number,
  overrides: Partial<InvoicePrediction> = {},
): InvoicePrediction => ({
  id: `p-${n}`,
  deploymentId: `d-${n}`,
  deploymentScope: "ORGANIZATION",
  registeredModel: "invoice-risk",
  modelVersion: String(n),
  runId: null,
  probability: 0.37,
  status: "SUCCEEDED",
  errorCode: null,
  createdAt: "2026-11-20T12:00:00.000Z",
  updatedAt: "2026-11-20T12:00:05.000Z",
  ...overrides,
});

describe("InvoicePredictions states", () => {
  it("shows a failed prediction as one badge, without an explanatory sentence (CR-563)", () => {
    render(
      <InvoicePredictions
        predictions={[prediction(1, { status: "FAILED", probability: null })]}
      />,
    );
    expect(screen.getAllByText("Fallida")).toHaveLength(1);
    expect(screen.queryByText(/No se pudo calcular/)).toBeNull();
  });

  it("shows a pending prediction as one signal: a badge with its spinner, no skeleton", () => {
    const { container } = render(
      <InvoicePredictions
        predictions={[prediction(1, { status: "PENDING", probability: null })]}
      />,
    );
    const badge = screen.getByText("Pendiente");
    expect(badge.querySelector(".icon-spin")).not.toBeNull();
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(container.querySelector(".skeleton-block")).toBeNull();
  });

  it("has an explicit state for a SUCCEEDED prediction without probability (CR-571)", () => {
    render(
      <InvoicePredictions
        predictions={[
          prediction(1, { status: "SUCCEEDED", probability: null }),
        ]}
      />,
    );
    expect(screen.getByText("Sin resultado")).toBeTruthy();
    expect(screen.queryByText("Probabilidad de rechazo")).toBeNull();
    expect(screen.queryByText(/NaN|0\s?%/)).toBeNull();
  });

  it("shows a SKIPPED prediction as one neutral badge, next to the others (CR-581)", () => {
    render(
      <InvoicePredictions
        predictions={[
          prediction(1),
          prediction(2, { status: "SKIPPED", probability: null }),
        ]}
      />,
    );
    expect(screen.getAllByText("Omitida")).toHaveLength(1);
    expect(screen.getByText("Omitida").className).toContain("is-neutral");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("announces changes politely through the list (CR-571)", () => {
    render(<InvoicePredictions predictions={[prediction(1)]} />);
    expect(screen.getByRole("list").getAttribute("aria-live")).toBe("polite");
  });
});

describe("InvoicePredictions when polling gave up (CR-552)", () => {
  const pending = [prediction(1, { status: "PENDING", probability: null })];

  it("stops the animation and offers one refresh", () => {
    const onRefresh = vi.fn();
    const { container } = render(
      <InvoicePredictions
        predictions={pending}
        stalled
        onRefresh={onRefresh}
      />,
    );
    expect(container.querySelector(".icon-spin")).toBeNull();
    const panel = screen.getByRole("region", { name: "Predicciones" });
    expect(panel.getAttribute("aria-busy")).toBeNull();
    // The state is still readable: it is pending, just not moving.
    expect(within(panel).getByText("Pendiente")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizar predicciones" }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("while polling is live it animates, is busy and offers no refresh", () => {
    const { container } = render(
      <InvoicePredictions predictions={pending} onRefresh={() => {}} />,
    );
    expect(container.querySelector(".icon-spin")).not.toBeNull();
    expect(
      screen
        .getByRole("region", { name: "Predicciones" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(
      screen.queryByRole("button", { name: "Actualizar predicciones" }),
    ).toBeNull();
  });
});

describe("rejectionPercent (CR-589)", () => {
  it("never rounds a probability below 1 up to a certain 100%", () => {
    for (const probability of [0.995, 0.997, 0.9999, 0.99999])
      expect(rejectionPercent(probability), String(probability)).toBe(
        "más de 99%",
      );
    expect(rejectionPercent(0.994)).toMatch(/^99\s?%$/);
    expect(rejectionPercent(1)).toMatch(/^100\s?%$/);
    expect(rejectionPercent(0.003)).toBe("menos de 1%");
  });

  it("renders «más de 99%» for such a prediction", () => {
    render(
      <InvoicePredictions
        predictions={[prediction(1, { probability: 0.998 })]}
      />,
    );
    expect(screen.getByText("más de 99%")).toBeTruthy();
  });
});
