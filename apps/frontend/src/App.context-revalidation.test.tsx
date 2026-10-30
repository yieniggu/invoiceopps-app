import { focusManager } from "@tanstack/react-query";
import { NO_PERMISSIONS } from "./test/transport";
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

const organization = {
  id: "00000000-0000-4000-9000-f9e9c6048aeb",
  name: "Academia A",
  slug: "academy-a",
};
const group = {
  id: "00000000-0000-4000-a000-ffdfcbaf90da",
  name: "Grupo A",
  description: null,
  organization,
  members: [],
};
const READ = { ...NO_PERMISSIONS, readInvoices: true };
function profileOf(access: { organizationRead: boolean; groupRead: boolean }) {
  return {
    id: "00000000-0000-4000-8000-00000000000a",
    name: "Ada",
    rut: "12345678-5",
    email: null,
    username: null,
    isPlatformAdministrator: false,
    memberships: [
      {
        organization,
        role: "ADMIN",
        permissions: access.organizationRead ? READ : NO_PERMISSIONS,
        groups: access.groupRead
          ? [
              {
                group: { id: group.id, name: group.name },
                permissions: NO_PERMISSIONS,
                effective: READ,
              },
            ]
          : [],
      },
    ],
  };
}
// Reads the whole organization (logout test) or only the group (the rest).
const orgReader = profileOf({ organizationRead: true, groupRead: false });
const groupReader = profileOf({ organizationRead: false, groupRead: true });
const revoked = profileOf({ organizationRead: false, groupRead: false });
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
function http(initial: ReturnType<typeof profileOf> = orgReader) {
  let currentProfile = initial;
  let profileReads = 0;
  let failProfile = false;
  const groups = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ groups: [group] }));
  const protectedRequests: string[] = [];
  const unexpected: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = input.toString();
    if (path === "/api/v1/auth/profile") {
      profileReads += 1;
      return failProfile ? json({}, 500) : json({ profile: currentProfile });
    }
    if (path === "/api/v1/groups") return groups();
    // Organization-scoped reads behind Mis grupos, and the self-removal that
    // makes the workspace catalogue revalidate.
    if (
      path ===
      "/api/v1/organizations/00000000-0000-4000-9000-f9e9c6048aeb/groups"
    )
      return json({
        groups: [
          {
            id: "00000000-0000-4000-a000-ffdfcbaf90da",
            organizationId: "00000000-0000-4000-9000-f9e9c6048aeb",
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
    if (
      path.split("?")[0] ===
      "/api/v1/organizations/00000000-0000-4000-9000-f9e9c6048aeb/groups/00000000-0000-4000-a000-ffdfcbaf90da/memberships"
    ) {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({
        memberships: [
          {
            userId: "00000000-0000-4000-8000-00000000000a",
            groupId: "00000000-0000-4000-a000-ffdfcbaf90da",
            organizationId: "00000000-0000-4000-9000-f9e9c6048aeb",
            permissions: NO_PERMISSIONS,
            user: {
              id: "00000000-0000-4000-8000-00000000000a",
              name: "Ada",
              rut: "123456785",
            },
          },
        ],
        page: 1,
        pageSize: 100,
        total: 1,
      });
    }
    if (
      path ===
        "/api/v1/organizations/00000000-0000-4000-9000-f9e9c6048aeb/groups/00000000-0000-4000-a000-ffdfcbaf90da/memberships/00000000-0000-4000-8000-00000000000a" &&
      init?.method === "DELETE"
    )
      return new Response(null, { status: 204 });
    if (
      path.split("?")[0] ===
      "/api/v1/organizations/00000000-0000-4000-9000-f9e9c6048aeb/users"
    )
      return json({
        users: [
          {
            id: "00000000-0000-4000-8000-00000000000a",
            name: "Ada",
            rut: "123456785",
            role: "ADMIN",
          },
        ],
        page: 1,
        pageSize: 100,
        total: 1,
      });
    if (path === "/api/v1/auth/logout" && init?.method === "POST")
      return new Response(null, { status: 204 });
    if (/^\/api\/v1\/invoices\?/.test(path)) {
      protectedRequests.push(path);
      const url = new URL(path, "http://test.invalid");
      const scope = url.searchParams.get("groupId") ?? "org";
      return json({
        items: [
          {
            id: "00000000-0000-4000-8000-0000000000aa",
            businessId: `FAC-${scope}`,
            organizationId: "00000000-0000-4000-9000-f9e9c6048aeb",
            groupId: url.searchParams.get("groupId"),
            currency: "CLP",
            issuedOn: "2026-10-25",
            dueOn: "2026-11-25",
            processingStatus: "NOT_REQUESTED",
            createdByUserId: "00000000-0000-4000-8000-000000000001",
            createdAt: "2026-10-21T00:00:00Z",
            supplierName: `Proveedor ${scope}`,
            amountPesos: 100,
            businessStatus: "PENDING",
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });
    }
    unexpected.push(path);
    throw new Error(`Unexpected request: ${path}`);
  });
  return {
    groups,
    protectedRequests,
    unexpected,
    profileReads: () => profileReads,
    setProfile: (next: ReturnType<typeof profileOf>) => {
      currentProfile = next;
    },
    failProfileReads: (fail: boolean) => {
      failProfile = fail;
    },
  };
}
/** Opens a URL the way the browser does (history entry + popstate). */
async function visit(path: string) {
  await act(async () => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
function navigate(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("link", { name }),
  );
}
const GROUP_ROWS = "Proveedor 00000000-0000-4000-a000-ffdfcbaf90da";

/**
 * Opens Facturas on the group, then removes the person from that group on its
 * screens. The removal is what makes the profile revalidate.
 */
async function leaveTheGroup(
  api: ReturnType<typeof http>,
  after: ReturnType<typeof profileOf>,
  { failRefresh = false }: { failRefresh?: boolean } = {},
) {
  render(<App />);
  await screen.findByRole("navigation");
  navigate("Facturas");
  await screen.findByText(GROUP_ROWS);
  navigate("Grupos");
  fireEvent.click(
    await screen.findByRole("link", { name: "Ver grupo Grupo A" }),
  );
  fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
  fireEvent.click(await screen.findByRole("link", { name: "Ada" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Quitar a Ada del grupo" }),
  );
  const reads = api.profileReads();
  api.setProfile(after);
  api.failProfileReads(failRefresh);
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirmar quitar a Ada" }),
  );
  await waitFor(() => expect(api.profileReads()).toBeGreaterThan(reads));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 S1 authorization context revalidation regressions", () => {
  it("stops offering and requesting the group once the profile confirms the removal", async () => {
    const api = http(groupReader);
    await leaveTheGroup(api, revoked);
    const boundary = api.protectedRequests.length;
    // With no invoice permission left the menu stops offering «Facturas»; the
    // URL itself explains the missing access and asks for nothing.
    await waitFor(() =>
      expect(
        within(screen.getByRole("navigation")).queryByRole("link", {
          name: "Facturas",
        }),
      ).toBeNull(),
    );
    await visit("/invoices");
    expect(await screen.findByText("Aún no puedes ver facturas")).toBeTruthy();
    expect(screen.queryByLabelText("Ver facturas de")).toBeNull();
    expect(screen.queryByText(GROUP_ROWS)).toBeNull();
    expect(api.protectedRequests.slice(boundary)).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

  it("keeps reading the group when the refreshed profile still grants it", async () => {
    const api = http(groupReader);
    await leaveTheGroup(api, groupReader);
    const boundary = api.protectedRequests.length;
    navigate("Facturas");
    await screen.findByText(GROUP_ROWS);
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: "Ver facturas de",
      }).value,
    ).toBe(
      "group:00000000-0000-4000-9000-f9e9c6048aeb:00000000-0000-4000-a000-ffdfcbaf90da",
    );
    expect(
      api.protectedRequests
        .slice(boundary)
        .every(
          (path) =>
            new URL(path, "http://test.invalid").searchParams.get("groupId") ===
            "00000000-0000-4000-a000-ffdfcbaf90da",
        ),
    ).toBe(true);
    expect(api.unexpected).toEqual([]);
  });

  it("keeps the last confirmed contexts while the revalidation fails and drops them once a read succeeds", async () => {
    const api = http(groupReader);
    await leaveTheGroup(api, revoked, { failRefresh: true });
    // The refresh failed: nothing new is confirmed, so the last profile stands
    // (the API still answers 403 to anything that is no longer allowed).
    navigate("Facturas");
    await screen.findByText(GROUP_ROWS);
    api.failProfileReads(false);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(await screen.findByText("Aún no puedes ver facturas")).toBeTruthy();
    expect(screen.queryByLabelText("Ver facturas de")).toBeNull();
    expect(screen.queryByText(GROUP_ROWS)).toBeNull();
    expect(
      within(screen.getByRole("navigation")).queryByRole("link", {
        name: "Facturas",
      }),
    ).toBeNull();
    expect(api.unexpected).toEqual([]);
  });

  it("sets an anonymous title after leaving Facturas through logout, not the previous protected title", async () => {
    http();
    render(<App />);
    await screen.findByRole("navigation");
    navigate("Facturas");
    await screen.findByText("Proveedor org");
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
