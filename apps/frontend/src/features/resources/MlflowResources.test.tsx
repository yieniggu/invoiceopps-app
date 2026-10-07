import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MlflowResources } from "./MlflowResources";

const context = {
  organizationId: "organization-1",
  ownerType: "user" as const,
  ownerId: "user-1",
};
const payload = {
  experiment: {
    id: "1",
    name: "student/123/invoice-risk",
    url: "https://mlflow.example/#/experiments/1?workspace=org",
  },
  runs: [
    {
      runId: "run-1",
      url: "https://mlflow.example/#/runs/run-1?workspace=org",
    },
  ],
  registeredModel: { name: "student-123-invoice-review" },
  versions: [{ version: "2" }],
  truncated: true,
  fetchedAt: "2026-10-05T00:00:00.000Z",
};
const success = () => new Response(JSON.stringify(payload), { status: 200 });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("APP-09 MLflow resource panel", () => {
  it("loads the selected context and renders trusted links, partial marker and all resource types", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(success());
    render(<MlflowResources context={context} />);
    expect(await screen.findByText("student/123/invoice-risk")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/mlflow/resources?organizationId=organization-1&ownerType=user&ownerId=user-1",
      expect.objectContaining({
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(screen.getByText(/Vista parcial/)).toBeTruthy();
    expect(screen.getByText("run-1")).toBeTruthy();
    expect(screen.getByText("student-123-invoice-review")).toBeTruthy();
    expect(screen.getByText("Versión 2")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "student/123/invoice-risk" })
        .getAttribute("rel"),
    ).toBe("noopener noreferrer");
  });

  it("retains the last successful snapshot on failure, then recovers without overlapping requests", async () => {
    let resolvePending: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolvePending = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(success());
    render(<MlflowResources context={context} />);
    expect(await screen.findByText("run-1")).toBeTruthy();
    // Returning to the visible tab triggers an immediate refresh.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("datos anteriores"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reintentar MLflow" }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar MLflow" }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => {
      resolvePending?.(success());
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("aborts a pending old context and never shows its response in the new context", async () => {
    let resolveOld: ((value: Response) => void) | undefined;
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...payload, runs: [] }), { status: 200 }),
      );
    const view = render(<MlflowResources key="old" context={context} />);
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
    view.rerender(
      <MlflowResources key="new" context={{ ...context, ownerId: "user-2" }} />,
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolveOld?.(success());
    });
    expect(
      await screen.findByText("No hay runs para este propietario."),
    ).toBeTruthy();
    expect(screen.queryByText("run-1")).toBeNull();
  });

  it("pauses when hidden, aborts its pending request and resumes when visible", async () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    let resolvePending: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolvePending = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(success());
    const view = render(<MlflowResources context={context} />);
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolvePending?.(success());
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText("run-1")).toBeTruthy();
    view.unmount();
    if (originalHidden)
      Object.defineProperty(document, "hidden", originalHidden);
    else Reflect.deleteProperty(document, "hidden");
  });

  it("polls once every 15 seconds while visible without a loading flicker", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(success());
    await act(async () => {
      render(<MlflowResources context={context} />);
    });
    expect(screen.getByText("run-1")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Cargando recursos de MLflow...")).toBeNull();
  });
});
