import {
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

describe("APP-05 resource ownership context", () => {
  const profile = {
    id: "user-1",
    memberships: [
      {
        organization: { id: "organization-1", name: "AI Academy" },
        role: "STUDENT",
      },
    ],
  };

  const groups = [
    {
      id: "group-1",
      name: "Advanced topics",
      organization: { id: "organization-1", name: "AI Academy" },
    },
  ];

  it("lets the user switch from their individual context to a group and filters visible resources", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resources: [
              {
                id: "resource-user",
                type: "ml-experiment",
                label: "Personal experiment",
                organizationId: "organization-1",
                ownerType: "user",
                ownerId: "user-1",
                createdByUserId: "user-1",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resources: [
              {
                id: "resource-group",
                type: "ml-model",
                label: "Group model",
                organizationId: "organization-1",
                ownerType: "group",
                ownerId: "group-1",
                createdByUserId: "user-1",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<ResourceContext profile={profile} groups={groups} />);

    expect(await screen.findByText("Personal experiment")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Propietario"), {
      target: { value: "group:group-1:organization-1" },
    });

    expect(await screen.findByText("Group model")).toBeTruthy();
    expect(
      screen.getAllByText("AI Academy · Grupo: Advanced topics"),
    ).toHaveLength(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/resources?organizationId=organization-1&ownerType=group&ownerId=group-1",
      { credentials: "same-origin" },
    );
  });

  it("exposes loading, empty, and recoverable error states", async () => {
    let resolveResources: ((response: Response) => void) | undefined;
    const pendingResources = new Promise<Response>((resolve) => {
      resolveResources = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(pendingResources)
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ resources: [] }), { status: 200 }),
      );

    render(<ResourceContext profile={profile} groups={groups} />);

    expect(screen.getByRole("status").textContent).toContain(
      "Cargando recursos",
    );
    resolveResources?.(
      new Response(JSON.stringify({ resources: [] }), { status: 200 }),
    );
    expect(
      await screen.findByText("No hay recursos para este propietario."),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Propietario"), {
      target: { value: "group:group-1:organization-1" },
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No fue posible cargar los recursos",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar recursos" }),
    );
    await waitFor(() => {
      expect(
        screen.getByText("No hay recursos para este propietario."),
      ).toBeTruthy();
    });
  });
});
