import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourceContext } from "./ResourceContext";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP-09 selector and live MLflow panel integration", () => {
  it("requests the selected owner and never renders a late previous-owner response", async () => {
    let resolveIndividual: ((response: Response) => void) | undefined;
    const individual = new Promise<Response>((resolve) => {
      resolveIndividual = resolve;
    });
    const calls: Array<{ path: string; signal?: AbortSignal }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const path = String(input);
      calls.push({ path, signal: init?.signal ?? undefined });
      if (path.startsWith("/mlflow/resources?")) {
        if (path.includes("ownerType=user")) return individual;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              experiment: { id: "2", name: "group/group-1/invoice-risk" },
              runs: [{ runId: "group-run" }],
              registeredModel: null,
              versions: [],
              truncated: false,
              fetchedAt: "2026-10-05T00:00:00.000Z",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ resources: [] }), { status: 200 }),
      );
    });

    render(
      <ResourceContext
        profile={{
          id: "user-1",
          memberships: [
            {
              organization: { id: "organization-1", name: "Academy" },
              role: "STUDENT",
            },
          ],
        }}
        groups={[
          {
            id: "group-1",
            name: "Team",
            organization: { id: "organization-1", name: "Academy" },
          },
        ]}
      />,
    );
    await waitFor(() =>
      expect(
        calls.some(
          ({ path }) =>
            path ===
            "/mlflow/resources?organizationId=organization-1&ownerType=user&ownerId=user-1",
        ),
      ).toBe(true),
    );
    const oldSignal = calls.find(({ path }) =>
      path.includes("ownerType=user"),
    )?.signal;
    fireEvent.change(screen.getByLabelText("Propietario"), {
      target: { value: "group:group-1:organization-1" },
    });
    expect(await screen.findByText("group-run")).toBeTruthy();
    expect(
      calls.some(
        ({ path }) =>
          path ===
          "/mlflow/resources?organizationId=organization-1&ownerType=group&ownerId=group-1",
      ),
    ).toBe(true);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      resolveIndividual?.(
        new Response(
          JSON.stringify({
            experiment: null,
            runs: [{ runId: "individual-run" }],
            registeredModel: null,
            versions: [],
            truncated: false,
            fetchedAt: "2026-10-05T00:00:00.000Z",
          }),
          { status: 200 },
        ),
      );
    });
    expect(screen.queryByText("individual-run")).toBeNull();
    expect(screen.getByText("group-run")).toBeTruthy();
  });
});
