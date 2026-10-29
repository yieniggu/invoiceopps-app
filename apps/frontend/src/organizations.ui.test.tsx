import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  deferred,
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  organizationsPage,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
  slug: "norte",
};
const south = {
  id: "00000000-0000-4000-9000-000000000002",
  name: "Instituto Sur",
  slug: "sur",
};
const platform = profileFixture({ isPlatformAdministrator: true });

function fillForm(values: {
  name: string;
  slug: string;
  description?: string;
  rut: string;
}) {
  fireEvent.change(screen.getByLabelText("Nombre de la organización"), {
    target: { value: values.name },
  });
  fireEvent.change(screen.getByLabelText("Identificador (slug)"), {
    target: { value: values.slug },
  });
  if (values.description)
    fireEvent.change(screen.getByLabelText("Descripción (opcional)"), {
      target: { value: values.description },
    });
  fireEvent.change(screen.getByLabelText(/RUT del primer administrador/), {
    target: { value: values.rut },
  });
}

describe("organization list (only my memberships)", () => {
  it("shows a card per membership with name, slug, role and a detail link", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            memberships: [
              membership(north, "ADMIN"),
              membership(south, "USER"),
            ],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Academia Norte" }),
    ).toBeTruthy();
    expect(screen.getByText("norte")).toBeTruthy();
    expect(screen.getByText("Administrador")).toBeTruthy();
    expect(screen.getByText("Usuario")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Ver detalle de Instituto Sur" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining(
        "/organizations/00000000-0000-4000-9000-000000000002",
      ),
    );
    // The profile is the source: the platform-wide list is never read here.
    expect(transport.calls("GET /api/v1/organizations")).toHaveLength(0);
  });

  // AC-15 / CR-230: the platform administrator's list is the paginated
  // platform directory, not the profile's memberships.
  it("lists every organization of the platform to the platform administrator, member or not", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            isPlatformAdministrator: true,
            memberships: [membership(north, "USER")],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations": () =>
        jsonResponse(
          organizationsPage(
            [north, south].map((org) => ({ ...org, description: null })),
          ),
        ),
    });
    renderApp({ route: "/organizations" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Instituto Sur" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Academia Norte" }),
    ).toBeTruthy();
    // The role badge only shows where the administrator is a member.
    expect(screen.getAllByText("Usuario")).toHaveLength(1);
    expect(transport.calls("GET /api/v1/organizations")[0].search).toBe(
      "?page=1&pageSize=20",
    );
  });

  it("tells a person without memberships what to do", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: profileFixture() }),
    });
    renderApp({ route: "/organizations" });
    expect(
      await screen.findByText(
        "Aún no perteneces a ninguna organización. Pide a un administrador que te agregue.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Crear organización" }),
    ).toBeNull();
  });

  it("offers Crear organización only to the platform administrator", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
    });
    renderApp({ route: "/organizations" });
    expect(
      await screen.findByRole("link", { name: "Crear organización" }),
    ).toHaveProperty("href", expect.stringContaining("/organizations/new"));
  });
});

describe("create organization screen (AC-11)", () => {
  it("creates an organization with its own payload, returns to the list with a notice and refetches the profile", async () => {
    let profile = platform;
    let listed: Array<Record<string, unknown>> = [];
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations": () =>
        jsonResponse(organizationsPage(listed)),
      "POST /api/v1/organizations": (request) => {
        const body = request.body as { name: string; slug: string };
        listed = [
          {
            id: "00000000-0000-4000-9000-000000000002",
            ...body,
            description: "Sede sur",
          },
        ];
        // The administrator named themselves first ADMIN.
        profile = profileFixture({
          isPlatformAdministrator: true,
          memberships: [
            membership(
              { id: "00000000-0000-4000-9000-000000000002", ...body },
              "ADMIN",
            ),
          ],
        });
        return jsonResponse(
          {
            organization: {
              id: "00000000-0000-4000-9000-000000000002",
              ...body,
              description: "Sede sur",
              enabled: true,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
            membership: {
              userId: "00000000-0000-4000-8000-000000000001",
              organizationId: "00000000-0000-4000-9000-000000000002",
              role: "ADMIN",
            },
          },
          201,
        );
      },
    });
    renderApp({ route: "/organizations/new" });
    await screen.findByRole("heading", {
      level: 1,
      name: "Crear organización",
    });
    fillForm({
      name: "  Instituto Sur ",
      slug: "sur",
      description: "Sede sur",
      rut: "12.345.678-5",
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));

    expect(
      await screen.findByText(/Organización «Instituto Sur» creada/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Organización «Instituto Sur» creada/).textContent,
    ).not.toContain("primer administrador");
    expect(window.location.pathname).toBe("/organizations");
    expect(transport.calls("POST /api/v1/organizations")).toHaveLength(1);
    expect(transport.calls("POST /api/v1/organizations")[0].body).toEqual({
      name: "Instituto Sur",
      slug: "sur",
      description: "Sede sur",
      firstAdminRut: "12345678-5",
    });
    // The new membership arrives with the refetched profile.
    expect(
      await screen.findByRole("heading", { level: 2, name: "Instituto Sur" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(2),
    );
    expect(transport.unexpected).toEqual([]);
  });

  it("tells a platform administrator who is not the first admin that the organization is in the list and can be opened (CR-230)", async () => {
    let listed: Array<Record<string, unknown>> = [];
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations": () =>
        jsonResponse(organizationsPage(listed)),
      "POST /api/v1/organizations": (request) => {
        const body = request.body as { name: string; slug: string };
        listed = [
          {
            id: "00000000-0000-4000-9000-000000000002",
            ...body,
            description: null,
          },
        ];
        return jsonResponse(
          {
            organization: {
              id: "00000000-0000-4000-9000-000000000002",
              ...body,
              description: null,
              enabled: true,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
            membership: {
              userId: "00000000-0000-4000-8000-000000000009",
              organizationId: "00000000-0000-4000-9000-000000000002",
              role: "ADMIN",
            },
          },
          201,
        );
      },
    });
    renderApp({ route: "/organizations/new" });
    await screen.findByRole("heading", {
      level: 1,
      name: "Crear organización",
    });
    // Somebody else (19.034.790-7) is the first administrator.
    fillForm({ name: "Instituto Sur", slug: "sur", rut: "19.034.790-7" });
    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));

    const notice = await screen.findByText(
      /Organización «Instituto Sur» creada\./,
    );
    // The notice is a floating toast that can be closed.
    expect(notice.closest(".toast")).toBeTruthy();
    expect(notice.textContent).toContain("Aparece en esta lista");
    expect(notice.textContent).toContain("puedes abrirla");
    expect(notice.textContent).toContain("primer administrador");
    // The stale "this app does not list or open it" wording is gone.
    expect(notice.textContent).not.toContain("aún no");
    expect(notice.textContent).not.toContain("no aparece");
    expect(window.location.pathname).toBe("/organizations");
    // The platform administrator is not a member, yet the directory lists it.
    expect(
      await screen.findByRole("heading", { level: 2, name: "Instituto Sur" }),
    ).toBeTruthy();
    expect(transport.calls("POST /api/v1/organizations")).toHaveLength(1);
  });

  it("opens an organization the platform administrator does not belong to by URL, with a loading state and no not-found flash", async () => {
    const detail = deferred<Response>();
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000002": () =>
        detail.promise,
    });
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000002" });
    expect(await screen.findByText("Cargando organización...")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Página no encontrada" }),
    ).toBeNull();
    detail.resolve(
      jsonResponse({
        organization: {
          id: "00000000-0000-4000-9000-000000000002",
          name: "Instituto Sur",
          slug: "sur",
          description: null,
        },
        summary: { memberCount: 0, groupCount: 0 },
      }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Instituto Sur" }),
    ).toBeTruthy();
    // canManage: the platform administrator gets the management links.
    expect(screen.getByRole("link", { name: "Agregar miembro" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Editar organización" }),
    ).toBeTruthy();
  });

  it("answers 404 for a missing organization with the not-found screen, and retries other failures", async () => {
    let calls = 0;
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000009": () => {
        calls += 1;
        return calls === 1
          ? errorResponse(500, "INTERNAL_ERROR")
          : errorResponse(404, "NOT_FOUND");
      },
    });
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000009" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar organización" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Página no encontrada",
      }),
    ).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("asks for no user or group fields to create an organization", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations/new" });
    const form = (
      await screen.findByRole("button", { name: "Crear organización" })
    ).closest("form") as HTMLFormElement;
    const labels = Array.from(form.querySelectorAll("label")).map(
      (label) => label.textContent,
    );
    expect(labels.join("|")).not.toMatch(/contraseña|grupo|usuario/i);
  });

  it("explains a slug conflict in Spanish, keeps the typed values and stays on the screen", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "POST /api/v1/organizations": () =>
        errorResponse(409, "ORGANIZATION_SLUG_CONFLICT"),
    });
    renderApp({ route: "/organizations/new" });
    await screen.findByRole("button", { name: "Crear organización" });
    fillForm({ name: "Instituto Sur", slug: "sur", rut: "12345678-5" });
    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Ya existe una organización con ese identificador.",
    );
    expect(
      (screen.getByLabelText("Identificador (slug)") as HTMLInputElement).value,
    ).toBe("sur");
    expect(window.location.pathname).toBe("/organizations/new");
  });

  it("validates slug and administrator RUT before sending and focuses the first invalid field", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations/new" });
    await screen.findByRole("button", { name: "Crear organización" });
    fillForm({ name: "Instituto Sur", slug: "Sur Norte", rut: "12345678-5" });
    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));
    const slug = screen.getByLabelText("Identificador (slug)");
    expect(document.activeElement).toBe(slug);
    expect(slug.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText(/solo minúsculas, números y guiones/i),
    ).toBeTruthy();
    expect(transport.calls("POST /api/v1/organizations")).toHaveLength(0);
  });

  it("shows a regular member a no-permission message instead of the form", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            memberships: [membership(north, "ADMIN")],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations/new" });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No tienes permiso para crear organizaciones",
    );
    expect(screen.queryByLabelText("Nombre de la organización")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Crear organización" }),
    ).toBeNull();
  });
});

describe("organization summary", () => {
  const summaryRoute = (counts = { memberCount: 3, groupCount: 2 }) => ({
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () =>
      jsonResponse({
        organization: {
          id: "00000000-0000-4000-9000-000000000001",
          name: "Academia Norte",
          slug: "norte",
          description: "Sede central",
        },
        summary: counts,
      }),
  });

  it("shows name, slug, description and the counts to a member, with only the groups link", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({ memberships: [membership(north, "USER")] }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      ...summaryRoute({ memberCount: 3, groupCount: 1 }),
    });
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000001" });
    expect(await screen.findByText("Sede central")).toBeTruthy();
    expect(screen.getByText("norte")).toBeTruthy();
    const counts = screen.getByRole("region", { name: "Resumen" });
    expect(counts.textContent).toContain("Miembros3");
    expect(counts.textContent).toContain("Mis grupos1");
    expect(
      within(screen.getByRole("main")).getByRole("link", { name: "Grupos" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining(
        "/organizations/00000000-0000-4000-9000-000000000001/groups",
      ),
    );
    // AC-22: a plain member may open the reduced member list, but has no
    // people-management entry point and reads no management data here.
    expect(screen.getByRole("link", { name: "Miembros" })).toHaveProperty(
      "href",
      expect.stringContaining(
        "/organizations/00000000-0000-4000-9000-000000000001/members",
      ),
    );
    expect(screen.queryByRole("link", { name: "Agregar miembro" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Editar organización" }),
    ).toBeNull();
    expect(screen.queryByLabelText(/RUT de la persona/)).toBeNull();
    expect(
      transport.requests.filter(({ path }) =>
        /\/(memberships|users)$/.test(path),
      ),
    ).toEqual([]);
  });

  it("gives an ADMIN the Miembros, Grupos and Agregar miembro links", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            memberships: [membership(north, "ADMIN")],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      ...summaryRoute(),
    });
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000001" });
    await screen.findByText("Sede central");
    const counts = screen.getByRole("region", { name: "Resumen" });
    expect(counts.textContent).toContain("Miembros3");
    expect(counts.textContent).toContain("Grupos2");
    expect(screen.getByRole("link", { name: "Miembros" })).toHaveProperty(
      "href",
      expect.stringContaining(
        "/organizations/00000000-0000-4000-9000-000000000001/members",
      ),
    );
    expect(
      screen.getByRole("link", { name: "Agregar miembro" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining(
        "/organizations/00000000-0000-4000-9000-000000000001/members/new",
      ),
    );
  });

  it("retries only the summary read when it fails", async () => {
    let calls = 0;
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({ memberships: [membership(north, "USER")] }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () => {
        calls += 1;
        return calls === 1
          ? errorResponse(500, "INTERNAL_ERROR")
          : summaryRoute()[
              "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001"
            ]();
      },
    });
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000001" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar organización" }),
    );
    expect(await screen.findByText("Sede central")).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("answers an organization that is not mine with the not-found screen", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            memberships: [membership(north, "USER")],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000009" });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Página no encontrada",
      }),
    ).toBeTruthy();
    // Only the platform administrator reads an organization they are not in.
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000009",
      ),
    ).toHaveLength(0);
  });
});

describe("organization directory for the platform administrator (AC-15)", () => {
  const listRoutes = (total = 45) => ({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations": ({ search }: { search: string }) => {
      const query = new URLSearchParams(search);
      return jsonResponse({
        organizations: [{ ...north, description: null }],
        page: Number(query.get("page")),
        pageSize: Number(query.get("pageSize")),
        total,
      });
    },
  });

  it("paginates with Anterior/Siguiente and keeps the page in the URL", async () => {
    const transport = mockTransport(listRoutes());
    renderApp({ route: "/organizations" });
    await screen.findByRole("heading", { level: 2, name: "Academia Norte" });
    expect(screen.getByText("Página 1 de 3")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Anterior" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("Página 2 de 3");
    expect(window.location.search).toBe("?page=2");
    expect(transport.calls("GET /api/v1/organizations").at(-1)?.search).toBe(
      "?page=2&pageSize=20",
    );
    // The buttons wait while the next page loads.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Siguiente" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("Página 3 de 3");
    expect(
      screen
        .getByRole("button", { name: "Siguiente" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("searches by term, resets to the first page and keeps the term in the URL", async () => {
    const transport = mockTransport(listRoutes());
    renderApp({ route: "/organizations?page=2" });
    await screen.findByText("Página 2 de 3");
    fireEvent.change(screen.getByLabelText("Buscar organización"), {
      target: { value: " nor " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(window.location.search).toBe("?search=nor"));
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/organizations").at(-1)?.search).toBe(
        "?page=1&pageSize=20&search=nor",
      ),
    );
    await screen.findByText("Página 1 de 3");
  });

  it("says when nothing matches", async () => {
    mockTransport({
      ...listRoutes(),
      "GET /api/v1/organizations": () => jsonResponse(organizationsPage([])),
    });
    renderApp({ route: "/organizations?search=zzz" });
    expect(
      await screen.findByText("No hay organizaciones que coincidan"),
    ).toBeTruthy();
  });

  it("shows a welcoming empty state, without pagination, when none exist", async () => {
    mockTransport({
      ...listRoutes(),
      "GET /api/v1/organizations": () => jsonResponse(organizationsPage([])),
    });
    renderApp({ route: "/organizations" });
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Aún no hay organizaciones",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Crea la primera para empezar a gestionar miembros y grupos.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Página 1 de/)).toBeNull();
  });

  it("suggests another term when a search finds nothing", async () => {
    mockTransport({
      ...listRoutes(),
      "GET /api/v1/organizations": () => jsonResponse(organizationsPage([])),
    });
    renderApp({ route: "/organizations?search=zzz" });
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "No hay organizaciones que coincidan",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Prueba con otro término de búsqueda."),
    ).toBeTruthy();
    expect(screen.queryByText(/Página 1 de/)).toBeNull();
  });

  it("lets the platform administrator open the groups of an organization they do not belong to", async () => {
    mockTransport({
      ...listRoutes(),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () =>
        jsonResponse({
          organization: { ...north, description: null },
          summary: { memberCount: 0, groupCount: 0 },
        }),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
        () => jsonResponse({ groups: [] }),
    });
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/groups",
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Grupos de la organización",
    });
    expect(screen.getByRole("link", { name: "Crear grupo" })).toBeTruthy();
  });

  it("keeps members on the profile-based list, without a search box", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({ memberships: [membership(north, "USER")] }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations" });
    await screen.findByRole("heading", { level: 2, name: "Academia Norte" });
    expect(screen.queryByLabelText("Buscar organización")).toBeNull();
    expect(screen.queryByText(/Página 1 de/)).toBeNull();
  });
});

describe("edit organization (AC-16)", () => {
  function editRoutes(
    profile: ReturnType<typeof profileFixture>,
    onPatch?: (body: unknown) => Response,
  ) {
    let stored = {
      id: "00000000-0000-4000-9000-000000000001",
      name: "Academia Norte",
      slug: "norte",
      description: "Sede central" as string | null,
    };
    // The profile carries the organization name for the people who belong to
    // it, so it answers with the stored (renamed) name after the PATCH.
    const currentProfile = () => ({
      ...profile,
      memberships: (
        profile.memberships as Array<{
          organization: { id: string; name: string };
        }>
      ).map((entry) =>
        entry.organization.id === stored.id
          ? {
              ...entry,
              organization: { ...entry.organization, name: stored.name },
            }
          : entry,
      ),
    });
    return {
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: currentProfile() }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations": () =>
        jsonResponse(organizationsPage([stored])),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () =>
        jsonResponse({
          organization: stored,
          summary: { memberCount: 2, groupCount: 1 },
        }),
      "PATCH /api/v1/organizations/00000000-0000-4000-9000-000000000001":
        (request: { body: unknown }) => {
          if (onPatch) return onPatch(request.body);
          stored = { ...stored, ...(request.body as object) };
          return jsonResponse({ organization: stored });
        },
    };
  }

  it("lets an ADMIN edit name and description, keeps the slug read-only and shows the saved data", async () => {
    const transport = mockTransport(
      editRoutes(profileFixture({ memberships: [membership(north, "ADMIN")] })),
    );
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000001" });
    fireEvent.click(
      await screen.findByRole("link", { name: "Editar organización" }),
    );
    await screen.findByRole("heading", {
      level: 1,
      name: "Editar organización",
    });
    expect(window.location.pathname).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/edit",
    );
    // The slug is shown, not editable; there is no first administrator.
    expect(screen.getByText("norte")).toBeTruthy();
    expect(screen.queryByLabelText(/Identificador/)).toBeNull();
    expect(screen.queryByLabelText(/RUT/)).toBeNull();
    expect(
      (screen.getByLabelText("Nombre de la organización") as HTMLInputElement)
        .value,
    ).toBe("Academia Norte");

    fireEvent.change(screen.getByLabelText("Nombre de la organización"), {
      target: { value: "  Academia Norte Chile " },
    });
    fireEvent.change(screen.getByLabelText("Descripción (opcional)"), {
      target: { value: "  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("Organización actualizada.")).toBeTruthy();
    expect(window.location.pathname).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001",
    );
    expect(
      transport.calls(
        "PATCH /api/v1/organizations/00000000-0000-4000-9000-000000000001",
      )[0].body,
    ).toEqual({
      name: "Academia Norte Chile",
      description: null,
    });
    // The detail and the profile were invalidated: the title is the NEW name.
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Academia Norte Chile",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Academia Norte" }),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("Sin descripción")).toBeTruthy(),
    );
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001",
      ).length,
    ).toBeGreaterThan(1);
  });

  it("validates the name and reports a server failure accessibly", async () => {
    const transport = mockTransport(
      editRoutes(
        profileFixture({ memberships: [membership(north, "ADMIN")] }),
        () => errorResponse(500, "INTERNAL_ERROR"),
      ),
    );
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/edit",
    });
    const name = await screen.findByLabelText("Nombre de la organización");
    fireEvent.change(name, { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(
      screen.getByText("Ingresa el nombre de la organización."),
    ).toBeTruthy();
    expect(document.activeElement).toBe(name);
    expect(
      transport.calls(
        "PATCH /api/v1/organizations/00000000-0000-4000-9000-000000000001",
      ),
    ).toHaveLength(0);

    fireEvent.change(name, { target: { value: "Otro nombre" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No fue posible guardar los cambios",
    );
    expect(window.location.pathname).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/edit",
    );
  });

  it("is available to the platform administrator without a membership, and not to a plain member", async () => {
    mockTransport(editRoutes(platform));
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000001" });
    expect(
      await screen.findByRole("link", { name: "Editar organización" }),
    ).toBeTruthy();
    cleanup();
    vi.restoreAllMocks();

    mockTransport(
      editRoutes(profileFixture({ memberships: [membership(north, "USER")] })),
    );
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000001" });
    await screen.findByText("Sede central");
    expect(
      screen.queryByRole("link", { name: "Editar organización" }),
    ).toBeNull();
    cleanup();

    window.history.replaceState(
      null,
      "",
      "/organizations/00000000-0000-4000-9000-000000000001/edit",
    );
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/edit",
    });
    expect(
      await screen.findByText(
        "Solo los administradores de la organización pueden editarla.",
      ),
    ).toBeTruthy();
  });
});
