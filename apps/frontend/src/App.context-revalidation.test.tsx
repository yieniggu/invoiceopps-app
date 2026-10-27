import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const organization = { id: "org-A", name: "Academia A", slug: "academy-a" };
const group = {
  id: "group-A",
  name: "Grupo A",
  description: null,
  organization,
  members: [],
};
const profile = {
  id: "user-A",
  name: "Ada",
  rut: "12345678-5",
  email: null,
  username: null,
  isPlatformAdministrator: false,
  memberships: [{ organization, role: "ADMIN" }],
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function http() {
  const groups = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ groups: [group] }));
  const protectedRequests: string[] = [];
  const unexpected: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = input.toString();
    if (path === "/api/v1/auth/profile") return json({ profile });
    if (path === "/api/v1/groups") return groups();
    // Organization-scoped reads behind Mis grupos, and the self-removal that
    // makes the workspace catalogue revalidate.
    if (path === "/api/v1/organizations/org-A/groups")
      return json({
        groups: [
          {
            id: "group-A",
            organizationId: "org-A",
            name: "Grupo A",
            description: null,
            permissions: {
              readInvoices: true,
              createInvoices: false,
              deleteOwnInvoices: false,
              deleteOthersInvoices: false,
            },
          },
        ],
      });
    if (path === "/api/v1/organizations/org-A/groups/group-A/memberships") {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({
        memberships: [
          {
            userId: "user-A",
            groupId: "group-A",
            organizationId: "org-A",
            user: { id: "user-A", name: "Ada", rut: "123456785" },
          },
        ],
      });
    }
    if (
      path ===
        "/api/v1/organizations/org-A/groups/group-A/memberships/user-A" &&
      init?.method === "DELETE"
    )
      return new Response(null, { status: 204 });
    if (path === "/api/v1/organizations/org-A/users")
      return json({
        users: [{ id: "user-A", name: "Ada", rut: "123456785", role: "ADMIN" }],
      });
    if (path === "/api/v1/auth/logout" && init?.method === "POST")
      return new Response(null, { status: 204 });
    if (/^\/api\/v1\/invoices\?/.test(path)) {
      protectedRequests.push(path);
      const url = new URL(path, "http://test.invalid");
      const owner = url.searchParams.get("ownerId");
      return json({
        invoices: [
          {
            id: `INV-${owner}`,
            businessId: `INV-${owner}`,
            organizationId: "organization-1",
            groupId: "group-1",
            currency: "CLP",
            issuedOn: "2026-10-25",
            dueOn: "2026-11-25",
            processingStatus: "NOT_REQUESTED",
            createdByUserId: "user-1",
            createdAt: "2026-10-21T00:00:00Z",
            supplierName: `Proveedor ${owner}`,
            amountPesos: 100,
            businessStatus: "PENDING",
          },
        ],
        nextCursor: null,
      });
    }
    unexpected.push(path);
    throw new Error(`Unexpected request: ${path}`);
  });
  return { groups, protectedRequests, unexpected };
}
function navigate(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("link", { name }),
  );
}
async function selectGroupAndLeave(
  api: ReturnType<typeof http>,
  pending: ReturnType<typeof deferred>,
) {
  render(<App />);
  await screen.findByRole("navigation");
  navigate("Facturas");
  await screen.findByText("Proveedor user-A");
  fireEvent.change(screen.getByRole("combobox", { name: "Propietario" }), {
    target: { value: "org-A:group:group-A" },
  });
  await screen.findByText("Proveedor group-A");
  api.groups.mockReturnValueOnce(pending.promise);
  navigate("Grupos");
  fireEvent.click(
    await screen.findByRole("link", { name: "Ver detalle de Grupo A" }),
  );
  // Removing yourself from the group is what forces the workspace to
  // revalidate its authorized contexts.
  fireEvent.click(
    await screen.findByRole("button", { name: "Quitar a Ada del grupo" }),
  );
  await waitFor(() => expect(api.groups).toHaveBeenCalledTimes(2));
}
function expectProtectedViewsBlocked(
  api: ReturnType<typeof http>,
  boundary: number,
  message: string,
) {
  for (const destination of ["Facturas"]) {
    navigate(destination);
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Propietario" })).toBeNull();
    expect(screen.queryByText("Proveedor group-A")).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Buscar por ID o proveedor" }),
    ).toBeNull();
    expect(api.protectedRequests.slice(boundary)).toEqual([]);
  }
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 S1 authorization context revalidation regressions", () => {
  it.each([false, true])(
    "blocks pending data and reconciles the selected group only after confirmed reload (revoked=%s)",
    async (revoked) => {
      const api = http();
      const pending = deferred();
      await selectGroupAndLeave(api, pending);
      const boundary = api.protectedRequests.length;
      expectProtectedViewsBlocked(
        api,
        boundary,
        "Cargando contexto de trabajo...",
      );
      await act(async () =>
        pending.resolve(json({ groups: revoked ? [] : [group] })),
      );
      const selector = await screen.findByRole<HTMLSelectElement>("combobox", {
        name: "Propietario",
      });
      expect(selector.value).toBe(revoked ? "" : "org-A:group:group-A");
      if (revoked) {
        expect(screen.queryByRole("option", { name: /Grupo A/ })).toBeNull();
        expect(api.protectedRequests.slice(boundary)).toEqual([]);
      } else {
        await screen.findByText("Proveedor group-A");
        expect(api.protectedRequests.slice(boundary)).toEqual([
          "/api/v1/invoices?organizationId=org-A&ownerType=group&ownerId=group-A&q=",
        ]);
      }
      if (revoked) {
        expect(
          screen.getByRole<HTMLSelectElement>("combobox", {
            name: "Propietario",
          }).value,
        ).toBe("");
        expect(api.protectedRequests.slice(boundary)).toEqual([]);
      } else {
        expect(
          api.protectedRequests
            .slice(boundary)
            .every(
              (path) =>
                new URL(path, "http://test.invalid").searchParams.get(
                  "ownerId",
                ) === "group-A",
            ),
        ).toBe(true);
      }
      expect(api.unexpected).toEqual([]);
    },
  );

  it("keeps failed revalidation blocked and restores the intended owner only after a successful retry", async () => {
    const api = http();
    const pending = deferred();
    await selectGroupAndLeave(api, pending);
    const boundary = api.protectedRequests.length;
    await act(async () => pending.resolve(json({}, 500)));
    expectProtectedViewsBlocked(
      api,
      boundary,
      "No fue posible cargar el contexto de trabajo.",
    );
    const retry = deferred();
    api.groups.mockReturnValueOnce(retry.promise);
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar contexto" }),
    );
    await waitFor(() => expect(api.groups).toHaveBeenCalledTimes(3));
    expectProtectedViewsBlocked(
      api,
      boundary,
      "Cargando contexto de trabajo...",
    );
    await act(async () => retry.resolve(json({ groups: [group] })));
    expect(
      (
        await screen.findByRole<HTMLSelectElement>("combobox", {
          name: "Propietario",
        })
      ).value,
    ).toBe("org-A:group:group-A");
    await screen.findByText("Proveedor group-A");
    expect(api.protectedRequests.slice(boundary)).toEqual([
      "/api/v1/invoices?organizationId=org-A&ownerType=group&ownerId=group-A&q=",
    ]);
    expect(api.unexpected).toEqual([]);
  });

  it("sets an anonymous title after leaving Facturas through logout, not the previous protected title", async () => {
    http();
    render(<App />);
    await screen.findByRole("navigation");
    navigate("Facturas");
    await screen.findByText("Proveedor user-A");
    expect(document.title).toBe("Facturas · InvoiceOps");
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(document.title).toBe("Iniciar sesión · InvoiceOps");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("sets a loading title while authoritative session discovery is pending", async () => {
    const pending = deferred();
    vi.spyOn(globalThis, "fetch").mockReturnValueOnce(pending.promise);
    document.title = "Facturas · InvoiceOps";
    render(<App />);
    expect(screen.getByRole("status").textContent).toBe(
      "Preparando tu espacio de trabajo",
    );
    expect(screen.queryByRole("heading", { name: "Mi perfil" })).toBeNull();
    expect(document.title).toBe(
      "Preparando tu espacio de trabajo · InvoiceOps",
    );
    await act(async () => pending.resolve(json({}, 401)));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(document.title).toBe("Iniciar sesión · InvoiceOps");
  });
});
