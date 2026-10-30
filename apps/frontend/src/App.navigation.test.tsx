import { namedId } from "./test/ids";
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
import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { openPolicies } from "./test/policiesRoute";

// Políticas is disabled in the product; the screen is kept unrouted. The
// shared-context test keeps exercising it through the test-only route.
vi.mock("./features/session/AppRoutes", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./features/session/AppRoutes")>();
  const { withPoliciesRoute } = await import("./test/policiesRoute");
  return { ...original, AppRoutes: withPoliciesRoute(original.AppRoutes) };
});

const organizations = [
  {
    id: "00000000-0000-4000-9000-f9e9c6048aeb",
    name: "Academia A",
    slug: "academy-a",
  },
  {
    id: "00000000-0000-4000-9000-fa19c6501c7e",
    name: "Academia B",
    slug: "academy-b",
  },
];
const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Ada Lovelace",
  rut: "12345678-5",
  email: "ada@example.test",
  username: "ada",
  isPlatformAdministrator: false,
  // «Facturas» is offered, and its contexts built, from the invoice flags of
  // the profile: the whole of each organization and the group of each.
  memberships: organizations.map((organization, index) => ({
    organization,
    role: "USER",
    permissions: { ...NO_PERMISSIONS, readInvoices: true },
    groups: [
      {
        group: {
          id: namedId("group", index === 0 ? "A" : "B"),
          name: `Grupo ${index === 0 ? "A" : "B"}`,
        },
        permissions: NO_PERMISSIONS,
        effective: { ...NO_PERMISSIONS, readInvoices: true },
      },
    ],
  })),
};
const groups = organizations.map((organization, index) => ({
  id: namedId("group", index === 0 ? "A" : "B"),
  name: `Grupo ${index === 0 ? "A" : "B"}`,
  description: null,
  organization: { id: organization.id, name: organization.name },
  members: [],
}));
const GROUP_B = namedId("group", "B");
const [ORG_A, ORG_B] = organizations.map(({ id }) => id);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Which scope of the inbox a request asked for: a group, ungrouped or the whole organization. */
function scopeOf(url: URL) {
  return (
    url.searchParams.get("groupId") ??
    `${url.searchParams.get("ungrouped") === "true" ? "ungrouped" : "org"}:${url.searchParams.get("organizationId")}`
  );
}

function listResponse(scope: string) {
  return json({
    items: [
      {
        id: "00000000-0000-4000-8000-0000000000aa",
        businessId: `FAC-${scope}`,
        organizationId: "00000000-0000-4000-9000-000000000001",
        groupId: null,
        currency: "CLP",
        issuedOn: "2026-10-25",
        dueOn: "2026-11-25",
        processingStatus: "NOT_REQUESTED",
        createdByUserId: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-10-21T00:00:00Z",
        supplierName: `Proveedor ${scope}`,
        amountPesos: 10000,
        businessStatus: "PENDING",
      },
    ],
    page: 1,
    pageSize: 20,
    total: 1,
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function mockHttp(anonymous = false) {
  const patch = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ profile }));
  const lists = vi
    .fn<(url: URL) => Promise<Response>>()
    .mockImplementation(async (url) => listResponse(scopeOf(url)));
  const unexpected: string[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = input instanceof Request ? input.url : input.toString();
      const url = new URL(path, "http://test.invalid");
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "PATCH" && url.pathname === "/api/v1/profile")
        return patch();
      if (method === "GET") {
        if (url.pathname === "/api/v1/auth/profile")
          return json(anonymous ? {} : { profile }, anonymous ? 401 : 200);
        if (url.pathname === "/api/v1/groups") return json({ groups });
        // Organization-scoped catalogue behind Mis grupos.
        const scoped = /^\/api\/v1\/organizations\/([^/]+)\/groups$/.exec(
          url.pathname,
        );
        if (scoped)
          return json({
            groups: groups
              .filter((group) => group.organization.id === scoped[1])
              .map(({ id, name, description, organization }) => ({
                id,
                organizationId: organization.id,
                name,
                description,
                permissions: {
                  readInvoices: false,
                  createInvoices: false,
                  deleteOwnInvoices: false,
                  deleteOthersInvoices: false,
                },
              })),
          });
        if (url.pathname === "/api/v1/business-policies")
          return json({ policies: [] });
        if (url.pathname === "/api/v1/invoices") return lists(url);
      }
      unexpected.push(`${method} ${path}`);
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
  return { fetchMock, lists, unexpected, patch };
}

function navigate(navigation: HTMLElement, name: string) {
  fireEvent.click(within(navigation).getByRole("link", { name }));
}

function selectGroupB() {
  const option = screen.getByRole<HTMLOptionElement>("option", {
    name: "Grupo B",
  });
  fireEvent.change(screen.getByLabelText("Ver facturas de"), {
    target: { value: option.value },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 S1 navigation and shared context", () => {
  it("offers accessible navigation to Panel principal and existing feature destinations after authentication", async () => {
    const api = mockHttp();
    render(<App />);

    const navigation = await screen.findByRole("navigation");
    for (const name of [
      "Panel principal",
      "Mi perfil",
      "Organizaciones",
      "Grupos",
      "Facturas",
    ]) {
      const queries = within(navigation);
      expect(queries.getByRole("link", { name })).toBeTruthy();
      navigate(navigation, name);
      const heading = screen.getByRole("heading", { name, level: 1 });
      expect(document.activeElement).toBe(heading);
      expect(document.title).toBe(`${name} · InvoiceOps`);
      expect(
        queries.getByRole("link", { name }).getAttribute("aria-current"),
      ).toBe("page");
    }
    // Políticas is disabled: a labelled, aria-disabled item that is not a link.
    expect(
      within(navigation).queryByRole("link", { name: "Políticas" }),
    ).toBeNull();
    const policies = within(navigation).getByRole("button", {
      name: "Políticas Próximamente",
    });
    expect(policies.getAttribute("aria-disabled")).toBe("true");
    expect(api.unexpected).toEqual([]);
  });

  it("loads feature data only when its destination is opened", async () => {
    const api = mockHttp();
    render(<App />);
    const navigation = await screen.findByRole("navigation");
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith("/api/v1/groups", {
        credentials: "same-origin",
      }),
    );
    expect(api.lists).not.toHaveBeenCalled();
    navigate(navigation, "Mi perfil");
    expect(api.lists).not.toHaveBeenCalled();
    navigate(navigation, "Facturas");
    await screen.findByText(`Proveedor org:${ORG_A}`);
    expect(
      api.lists.mock.calls.every(
        ([url]) => url.pathname === "/api/v1/invoices",
      ),
    ).toBe(true);
  });

  it("removes a revoked organization and its group without reusing delayed context data", async () => {
    const api = mockHttp();
    let currentProfile = { ...profile };
    const original = api.fetchMock.getMockImplementation()!;
    api.fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/auth/profile" && !init?.method)
        return json({ profile: currentProfile });
      return original(input, init);
    });
    const pending = deferredResponse();
    render(<App />);
    const navigation = await screen.findByRole("navigation");
    navigate(navigation, "Facturas");
    await screen.findByText(`Proveedor org:${ORG_A}`);
    api.lists.mockImplementation(async (url) =>
      scopeOf(url) === GROUP_B ? pending.promise : listResponse(scopeOf(url)),
    );
    selectGroupB();
    await waitFor(() =>
      expect(
        api.lists.mock.calls.some(([url]) => scopeOf(url) === GROUP_B),
      ).toBe(true),
    );
    // Contact PATCH no longer publishes capabilities (CR009). Keep the original
    // revocation assertions, using the actual authoritative GET refresh instead.
    currentProfile = {
      ...currentProfile,
      memberships: [profile.memberships[0]],
    };
    // The authoritative refresh is the profile refetch on window focus.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    navigate(navigation, "Panel principal");
    await waitFor(() =>
      expect(
        api.fetchMock.mock.calls.filter(
          ([path]) => String(path) === "/api/v1/auth/profile",
        ).length,
      ).toBeGreaterThan(1),
    );
    await screen.findByRole("heading", { level: 1, name: "Panel principal" });
    const boundary = api.lists.mock.calls.length;
    navigate(navigation, "Facturas");
    expect(screen.queryByRole("option", { name: /Academia B/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Grupo B/ })).toBeNull();
    // Back on the default context of the organization that is left.
    expect(
      screen.getByLabelText<HTMLSelectElement>("Ver facturas de").value,
    ).toBe(`organization:${ORG_A}`);
    await screen.findByText(`Proveedor org:${ORG_A}`);
    expect(
      api.lists.mock.calls
        .slice(boundary)
        .every(([url]) => url.searchParams.get("organizationId") === ORG_A),
    ).toBe(true);
    expect(screen.queryByText(`Proveedor ${GROUP_B}`)).toBeNull();
    // Even after returning to invoices, revoked groups are excluded.
    navigate(navigation, "Panel principal");
    navigate(navigation, "Facturas");
    expect(screen.queryByRole("option", { name: /Grupo B/ })).toBeNull();
    await act(async () => pending.resolve(listResponse(GROUP_B)));
    expect(screen.queryByText(`Proveedor ${GROUP_B}`)).toBeNull();
    expect(api.unexpected).toEqual([]);
  });

  it("keeps the chosen invoice context in the URL only: Políticas and the menu do not carry it", async () => {
    const api = mockHttp();
    render(<App />);

    const navigation = await screen.findByRole("navigation");
    navigate(navigation, "Facturas");
    await screen.findByText(`Proveedor org:${ORG_A}`);
    selectGroupB();
    await screen.findByText(`Proveedor ${GROUP_B}`);
    expect(
      screen.getByRole<HTMLOptionElement>("option", {
        name: "Grupo B",
      }).selected,
    ).toBe(true);
    expect(
      api.lists.mock.calls.some(
        ([url]) =>
          url.pathname === "/api/v1/invoices" &&
          url.searchParams.get("organizationId") === ORG_B &&
          url.searchParams.get("groupId") === GROUP_B &&
          !url.searchParams.has("ownerType") &&
          !url.searchParams.has("ownerId"),
      ),
    ).toBe(true);
    expect(window.location.search).toContain(`groupId=${GROUP_B}`);

    await openPolicies();
    await screen.findByRole("heading", { name: "Políticas", level: 1 });

    navigate(navigation, "Facturas");
    await screen.findByText(`Proveedor org:${ORG_A}`);
    expect(screen.queryByText(`Proveedor ${GROUP_B}`)).toBeNull();
    expect(api.unexpected).toEqual([]);
  });

  it("control: rejects a delayed context A response after selecting context B", async () => {
    const api = mockHttp();
    const pending = deferredResponse();
    api.lists.mockImplementation(async (url) =>
      scopeOf(url) === `org:${ORG_A}`
        ? pending.promise
        : listResponse(scopeOf(url)),
    );
    try {
      render(<App />);
      navigate(await screen.findByRole("navigation"), "Facturas");
      await screen.findByLabelText("Ver facturas de");
      await waitFor(() =>
        expect(
          api.lists.mock.calls.some(([url]) => scopeOf(url) === `org:${ORG_A}`),
        ).toBe(true),
      );
      selectGroupB();
      const current = `Proveedor ${GROUP_B}`;
      await screen.findByText(current);
      await act(async () => pending.resolve(listResponse(`org:${ORG_A}`)));

      expect(screen.getByText(current)).toBeTruthy();
      expect(screen.queryByText(`Proveedor org:${ORG_A}`)).toBeNull();
      expect(
        screen.getByRole<HTMLOptionElement>("option", {
          name: "Grupo B",
        }).selected,
      ).toBe(true);
      expect(api.unexpected).toEqual([]);
    } finally {
      await act(async () => pending.resolve(listResponse(`org:${ORG_A}`)));
    }
  });

  it("ignores a delayed response body after the context changes", async () => {
    const api = mockHttp();
    let completeBody!: (value: unknown) => void;
    const response = json({});
    const body = vi.spyOn(response, "json").mockReturnValue(
      new Promise<unknown>((resolve) => {
        completeBody = resolve;
      }),
    );
    api.lists.mockImplementation(async (url) =>
      scopeOf(url) === `org:${ORG_A}` ? response : listResponse(scopeOf(url)),
    );
    render(<App />);
    navigate(await screen.findByRole("navigation"), "Facturas");
    await waitFor(() => expect(body).toHaveBeenCalledTimes(1));
    selectGroupB();
    const current = `Proveedor ${GROUP_B}`;
    await screen.findByText(current);
    await act(async () =>
      completeBody(await listResponse(`org:${ORG_A}`).json()),
    );
    expect(screen.getByText(current)).toBeTruthy();
    expect(screen.queryByText(`Proveedor org:${ORG_A}`)).toBeNull();
    expect(api.unexpected).toEqual([]);
  });

  it("control: loads the authenticated profile and invoices of the default organization context", async () => {
    const api = mockHttp();
    render(<App />);
    navigate(await screen.findByRole("navigation"), "Mi perfil");
    expect(screen.getByText(profile.name)).toBeTruthy();
    navigate(screen.getByRole("navigation"), "Facturas");
    await screen.findByText(`Proveedor org:${ORG_A}`);
    expect(api.fetchMock).toHaveBeenCalledWith("/api/v1/auth/profile", {
      credentials: "same-origin",
    });
    expect(api.fetchMock).toHaveBeenCalledWith("/api/v1/groups", {
      credentials: "same-origin",
    });
    expect(
      api.lists.mock.calls.some(
        ([url]) =>
          url.pathname === "/api/v1/invoices" &&
          url.searchParams.get("organizationId") === ORG_A &&
          !url.searchParams.has("groupId") &&
          !url.searchParams.has("ownerType") &&
          !url.searchParams.has("ownerId"),
      ),
    ).toBe(true);
    expect(api.unexpected).toEqual([]);
  });

  it("does not request protected data for an anonymous session, allowing GET /profile discovery", async () => {
    const api = mockHttp(true);
    render(<App />);
    await screen.findByRole("button", { name: "Iniciar sesión" });

    expect(api.fetchMock).toHaveBeenCalledTimes(1);
    expect(api.fetchMock).toHaveBeenCalledWith("/api/v1/auth/profile", {
      credentials: "same-origin",
    });
    expect(api.lists).not.toHaveBeenCalled();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(api.unexpected).toEqual([]);
  });
});
