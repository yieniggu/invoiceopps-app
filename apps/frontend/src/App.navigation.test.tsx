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

const organizations = [
  { id: "org-A", name: "Academia A", slug: "academy-a" },
  { id: "org-B", name: "Academia B", slug: "academy-b" },
];
const profile = {
  id: "user-1",
  name: "Ada Lovelace",
  rut: "123456785",
  email: "ada@example.test",
  username: "ada",
  isPlatformAdministrator: false,
  memberships: organizations.map((organization) => ({
    organization,
    role: "STUDENT",
  })),
};
const groups = organizations.map((organization, index) => ({
  id: `group-${index === 0 ? "A" : "B"}`,
  name: `Grupo ${index === 0 ? "A" : "B"}`,
  description: null,
  organization: { id: organization.id, name: organization.name },
  members: [],
}));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function listResponse(path: string, ownerId: string) {
  if (path === "/resources") {
    return json({
      resources: [
        {
          id: `resource-${ownerId}`,
          type: "ml-experiment",
          label: `Recurso ${ownerId}`,
        },
      ],
    });
  }
  return json({
    invoices: [
      {
        invoiceId: `invoice-${ownerId}`,
        vendorName: `Proveedor ${ownerId}`,
        invoiceAmountCents: 10000,
        hasPurchaseOrder: true,
        threeWayMatch: true,
        status: "PENDING",
        policyProbability: null,
        policyProbabilitySource: null,
      },
    ],
    nextCursor: null,
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
    .mockImplementation(async (url) =>
      listResponse(url.pathname, url.searchParams.get("ownerId") ?? ""),
    );
  const unexpected: string[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = input instanceof Request ? input.url : input.toString();
      const url = new URL(path, "http://test.invalid");
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "PATCH" && url.pathname === "/profile") return patch();
      if (method === "GET") {
        if (url.pathname === "/profile")
          return json(anonymous ? {} : { profile }, anonymous ? 401 : 200);
        if (url.pathname === "/groups") return json({ groups });
        if (url.pathname === "/business-policies")
          return json({ policies: [] });
        if (url.pathname === "/resources" || url.pathname === "/invoices")
          return lists(url);
        if (url.pathname === "/mlflow/resources")
          return json({
            experiment: null,
            runs: [],
            registeredModel: null,
            versions: [],
            truncated: false,
            fetchedAt: "2026-10-21T12:00:00.000Z",
          });
      }
      unexpected.push(`${method} ${path}`);
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
  return { fetchMock, lists, unexpected, patch };
}

function navigate(navigation: HTMLElement, name: string) {
  const queries = within(navigation);
  const destination =
    queries.queryByRole("link", { name }) ??
    queries.getByRole("button", { name });
  fireEvent.click(destination);
}

function selectGroupB() {
  const option = screen.getByRole<HTMLOptionElement>("option", {
    name: "Academia B · Grupo: Grupo B",
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Propietario" }), {
    target: { value: option.value },
  });
}

function expectGroupBVisible() {
  expect(
    screen.getAllByText("Academia B · Grupo: Grupo B", {
      selector: ":not(option)",
    }).length,
  ).toBeGreaterThan(0);
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
      "Mis grupos",
      "Recursos",
      "Facturas",
      "Políticas",
    ]) {
      const queries = within(navigation);
      expect(
        queries.queryByRole("link", { name }) ??
          queries.getByRole("button", { name }),
      ).toBeTruthy();
      navigate(navigation, name);
      const heading = screen.getByRole("heading", { name, level: 1 });
      expect(document.activeElement).toBe(heading);
      expect(document.title).toBe(`${name} · InvoiceOps`);
      expect(
        queries.getByRole("button", { name }).getAttribute("aria-current"),
      ).toBe("page");
    }
    expect(api.unexpected).toEqual([]);
  });

  it("loads feature data only when its destination is opened", async () => {
    const api = mockHttp();
    render(<App />);
    const navigation = await screen.findByRole("navigation");
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith("/groups", {
        credentials: "same-origin",
      }),
    );
    expect(api.lists).not.toHaveBeenCalled();
    navigate(navigation, "Mi perfil");
    expect(api.lists).not.toHaveBeenCalled();
    navigate(navigation, "Facturas");
    await screen.findByText("Proveedor user-1");
    expect(
      api.lists.mock.calls.every(([url]) => url.pathname === "/invoices"),
    ).toBe(true);
  });

  it("removes a revoked organization and its group without reusing delayed context data", async () => {
    const api = mockHttp();
    let currentProfile = { ...profile, isPlatformAdministrator: true };
    let discoveryReady = false;
    const original = api.fetchMock.getMockImplementation()!;
    api.fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/profile" && !init?.method)
        return json({ profile: currentProfile });
      if (String(input) === "/platform/organizations")
        return discoveryReady ? json({ organizations: [] }) : json({}, 500);
      return original(input, init);
    });
    const pending = deferredResponse();
    render(<App />);
    const navigation = await screen.findByRole("navigation");
    navigate(navigation, "Recursos");
    await screen.findByText("Recurso user-1");
    api.lists.mockImplementation(async (url) =>
      url.searchParams.get("ownerId") === "group-B"
        ? pending.promise
        : listResponse(url.pathname, url.searchParams.get("ownerId") ?? ""),
    );
    selectGroupB();
    await waitFor(() =>
      expect(
        api.lists.mock.calls.some(
          ([url]) => url.searchParams.get("ownerId") === "group-B",
        ),
      ).toBe(true),
    );
    // Contact PATCH no longer publishes capabilities (CR009). Keep the original
    // revocation assertions, using the actual authoritative GET refresh instead.
    currentProfile = {
      ...currentProfile,
      memberships: [profile.memberships[0]],
    };
    discoveryReady = true;
    navigate(navigation, "Administración");
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar organizaciones" }),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Contexto de trabajo").textContent,
      ).toContain("Contexto no disponible"),
    );
    const boundary = api.lists.mock.calls.length;
    navigate(navigation, "Facturas");
    expect(screen.queryByRole("option", { name: /Academia B/ })).toBeNull();
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Propietario" })
        .value,
    ).toBe("");
    expect(api.lists.mock.calls.slice(boundary)).toEqual([]);
    expect(screen.queryByText("Proveedor group-B")).toBeNull();
    // Even after returning to resources, revoked groups from the old /groups response are excluded.
    navigate(navigation, "Recursos");
    expect(screen.queryByRole("option", { name: /Grupo B/ })).toBeNull();
    expect(screen.queryByText("Recurso group-B")).toBeNull();
    await act(async () =>
      pending.resolve(listResponse("/resources", "group-B")),
    );
    expect(screen.queryByText("Recurso group-B")).toBeNull();
    expect(api.unexpected).toEqual([]);
  });

  it("keeps the selected organization and group visible and current across resources and invoices", async () => {
    const api = mockHttp();
    render(<App />);

    const navigation = await screen.findByRole("navigation");
    navigate(navigation, "Recursos");
    await screen.findByText("Recurso user-1");
    selectGroupB();
    await screen.findByText("Recurso group-B");
    expectGroupBVisible();

    navigate(navigation, "Facturas");
    await screen.findByText("Proveedor group-B");
    expectGroupBVisible();
    expect(
      api.lists.mock.calls.some(
        ([url]) =>
          url.pathname === "/invoices" &&
          url.searchParams.get("organizationId") === "org-B" &&
          url.searchParams.get("ownerType") === "group" &&
          url.searchParams.get("ownerId") === "group-B",
      ),
    ).toBe(true);

    navigate(navigation, "Recursos");
    await screen.findByText("Recurso group-B");
    expectGroupBVisible();
    expect(screen.queryByText("Recurso user-1")).toBeNull();
    expect(api.unexpected).toEqual([]);
  });

  it.each([
    { path: "/resources", current: "Recurso group-B", stale: "Recurso user-1" },
    {
      path: "/invoices",
      current: "Proveedor group-B",
      stale: "Proveedor user-1",
    },
  ])(
    "control: rejects a delayed $path context A response after selecting context B",
    async ({ path, current, stale }) => {
      const api = mockHttp();
      const pending = deferredResponse();
      api.lists.mockImplementation(async (url) =>
        url.pathname === path && url.searchParams.get("ownerId") === "user-1"
          ? pending.promise
          : listResponse(url.pathname, url.searchParams.get("ownerId") ?? ""),
      );
      try {
        render(<App />);
        navigate(
          await screen.findByRole("navigation"),
          path === "/invoices" ? "Facturas" : "Recursos",
        );
        await screen.findByRole("combobox", { name: "Propietario" });
        await waitFor(() =>
          expect(
            api.lists.mock.calls.some(([url]) => url.pathname === path),
          ).toBe(true),
        );
        const region = screen
          .getAllByRole("region", {
            name: path === "/resources" ? "Recursos" : "Facturas",
          })
          .find((candidate) =>
            within(candidate).queryByRole("combobox", { name: "Propietario" }),
          );
        if (!region)
          throw new Error(
            "Owner context selector was not rendered in the feature region",
          );
        const option = within(region).getByRole<HTMLOptionElement>("option", {
          name: "Academia B · Grupo: Grupo B",
        });
        const selector = within(region).getByRole("combobox", {
          name: "Propietario",
        });
        fireEvent.change(selector, { target: { value: option.value } });
        await screen.findByText(current);
        await act(async () => pending.resolve(listResponse(path, "user-1")));

        expect(screen.getByText(current)).toBeTruthy();
        expect(screen.queryByText(stale)).toBeNull();
        expect(
          screen.getByRole<HTMLOptionElement>("option", {
            name: "Academia B · Grupo: Grupo B",
          }).selected,
        ).toBe(true);
        expect(
          within(
            screen.getByRole("region", {
              name: path === "/resources" ? "Recursos" : "Facturas",
            }),
          ).getByText("Academia B · Grupo: Grupo B", {
            selector: ":not(option)",
          }),
        ).toBeTruthy();
        expect(api.unexpected).toEqual([]);
      } finally {
        await act(async () => pending.resolve(listResponse(path, "user-1")));
      }
    },
  );

  it.each(["/resources", "/invoices"])(
    "ignores a delayed %s response body after the shared owner changes",
    async (path) => {
      const api = mockHttp();
      let completeBody!: (value: unknown) => void;
      const response = json({});
      const body = vi.spyOn(response, "json").mockReturnValue(
        new Promise<unknown>((resolve) => {
          completeBody = resolve;
        }),
      );
      api.lists.mockImplementation(async (url) =>
        url.pathname === path && url.searchParams.get("ownerId") === "user-1"
          ? response
          : listResponse(url.pathname, url.searchParams.get("ownerId") ?? ""),
      );
      render(<App />);
      navigate(
        await screen.findByRole("navigation"),
        path === "/resources" ? "Recursos" : "Facturas",
      );
      await waitFor(() => expect(body).toHaveBeenCalledTimes(1));
      selectGroupB();
      const current =
        path === "/resources" ? "Recurso group-B" : "Proveedor group-B";
      await screen.findByText(current);
      await act(async () =>
        completeBody(await listResponse(path, "user-1").json()),
      );
      expect(screen.getByText(current)).toBeTruthy();
      expect(
        screen.queryByText(
          path === "/resources" ? "Recurso user-1" : "Proveedor user-1",
        ),
      ).toBeNull();
      expect(api.unexpected).toEqual([]);
    },
  );

  it("control: loads the authenticated profile and resources using the existing organization and owner contract", async () => {
    const api = mockHttp();
    render(<App />);
    navigate(await screen.findByRole("navigation"), "Mi perfil");
    expect(screen.getByText(profile.name)).toBeTruthy();
    navigate(screen.getByRole("navigation"), "Recursos");
    await screen.findByText("Recurso user-1");
    expect(api.fetchMock).toHaveBeenCalledWith("/profile", {
      credentials: "same-origin",
    });
    expect(api.fetchMock).toHaveBeenCalledWith("/groups", {
      credentials: "same-origin",
    });
    expect(
      api.lists.mock.calls.some(
        ([url]) =>
          url.pathname === "/resources" &&
          url.searchParams.get("organizationId") === "org-A" &&
          url.searchParams.get("ownerType") === "user" &&
          url.searchParams.get("ownerId") === profile.id,
      ),
    ).toBe(true);
    expect(api.unexpected).toEqual([]);
  });

  it("does not request protected data for an anonymous session, allowing GET /profile discovery", async () => {
    const api = mockHttp(true);
    render(<App />);
    await screen.findByRole("button", { name: "Iniciar sesión" });

    expect(api.fetchMock).toHaveBeenCalledTimes(1);
    expect(api.fetchMock).toHaveBeenCalledWith("/profile", {
      credentials: "same-origin",
    });
    expect(api.lists).not.toHaveBeenCalled();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(api.unexpected).toEqual([]);
  });
});
