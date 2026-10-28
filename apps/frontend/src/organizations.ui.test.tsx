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
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const north = { id: "org-1", name: "Academia Norte", slug: "norte" };
const south = { id: "org-2", name: "Instituto Sur", slug: "sur" };
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
    ).toHaveProperty("href", expect.stringContaining("/organizations/org-2"));
    // The profile is the source: the platform-wide list is never read here.
    expect(transport.calls("GET /api/v1/organizations")).toHaveLength(0);
  });

  it("does not list organizations the person does not belong to, even as platform administrator", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            isPlatformAdministrator: true,
            memberships: [membership(north, "USER")],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations" });
    await screen.findByRole("heading", { level: 2, name: "Academia Norte" });
    expect(screen.queryByText("Instituto Sur")).toBeNull();
    expect(transport.calls("GET /api/v1/organizations")).toHaveLength(0);
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
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "POST /api/v1/organizations": (request) => {
        const body = request.body as { name: string; slug: string };
        // The administrator named themselves first ADMIN.
        profile = profileFixture({
          isPlatformAdministrator: true,
          memberships: [membership({ id: "org-2", ...body }, "ADMIN")],
        });
        return jsonResponse(
          {
            organization: {
              id: "org-2",
              ...body,
              description: "Sede sur",
              enabled: true,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
            membership: {
              userId: "user-1",
              organizationId: "org-2",
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
    expect(screen.getByRole("status").textContent).not.toContain(
      "primer administrador",
    );
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

  it("explains to a platform administrator who is not the first admin why the new organization is not in the list (CR-230)", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "POST /api/v1/organizations": (request) => {
        const body = request.body as { name: string; slug: string };
        return jsonResponse(
          {
            organization: {
              id: "org-2",
              ...body,
              description: null,
              enabled: true,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
            membership: {
              userId: "user-9",
              organizationId: "org-2",
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

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(
      "Organización «Instituto Sur» creada.",
    );
    expect(notice.textContent).toContain("No aparece en esta lista");
    expect(notice.textContent).toContain("no eres miembro de ella");
    expect(notice.textContent).toContain("primer administrador");
    expect(notice.textContent).toContain("directorio de organizaciones");
    expect(notice.textContent).toContain("no lista ni abre organizaciones");
    expect(window.location.pathname).toBe("/organizations");
    // The platform administrator is not a member: no card for the new one.
    expect(
      screen.queryByRole("heading", { level: 2, name: "Instituto Sur" }),
    ).toBeNull();
    expect(transport.calls("POST /api/v1/organizations")).toHaveLength(1);
  });

  it("does not open an organization of which the platform administrator is not a member, even by URL (what the CR-230 notice says)", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations/org-2" });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Página no encontrada",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("No encontramos esa organización entre las tuyas."),
    ).toBeTruthy();
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
    "GET /api/v1/organizations/org-1": () =>
      jsonResponse({
        organization: {
          id: "org-1",
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
    renderApp({ route: "/organizations/org-1" });
    expect(await screen.findByText("Sede central")).toBeTruthy();
    expect(screen.getByText("norte")).toBeTruthy();
    const counts = screen.getByRole("region", { name: "Resumen" });
    expect(counts.textContent).toContain("Miembros3");
    expect(counts.textContent).toContain("Mis grupos1");
    expect(
      within(screen.getByRole("main")).getByRole("link", { name: "Grupos" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining("/organizations/org-1/groups"),
    );
    // A plain member neither sees nor reads the people of the organization.
    expect(screen.queryByRole("link", { name: "Miembros" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Agregar miembro" })).toBeNull();
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
    renderApp({ route: "/organizations/org-1" });
    await screen.findByText("Sede central");
    const counts = screen.getByRole("region", { name: "Resumen" });
    expect(counts.textContent).toContain("Miembros3");
    expect(counts.textContent).toContain("Grupos2");
    expect(screen.getByRole("link", { name: "Miembros" })).toHaveProperty(
      "href",
      expect.stringContaining("/organizations/org-1/members"),
    );
    expect(
      screen.getByRole("link", { name: "Agregar miembro" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining("/organizations/org-1/members/new"),
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
      "GET /api/v1/organizations/org-1": () => {
        calls += 1;
        return calls === 1
          ? errorResponse(500, "INTERNAL_ERROR")
          : summaryRoute()["GET /api/v1/organizations/org-1"]();
      },
    });
    renderApp({ route: "/organizations/org-1" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar organización" }),
    );
    expect(await screen.findByText("Sede central")).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("answers an organization that is not mine with the not-found screen", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            isPlatformAdministrator: true,
            memberships: [membership(north, "USER")],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizations/org-9" });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Página no encontrada",
      }),
    ).toBeTruthy();
  });
});
