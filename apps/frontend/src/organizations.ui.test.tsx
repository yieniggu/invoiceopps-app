import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
    renderApp({ route: "/organizaciones" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Academia Norte" }),
    ).toBeTruthy();
    expect(screen.getByText("norte")).toBeTruthy();
    expect(screen.getByText("Administrador")).toBeTruthy();
    expect(screen.getByText("Miembro")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Ver detalle de Instituto Sur" }),
    ).toHaveProperty("href", expect.stringContaining("/organizaciones/org-2"));
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
    renderApp({ route: "/organizaciones" });
    await screen.findByRole("heading", { level: 2, name: "Academia Norte" });
    expect(screen.queryByText("Instituto Sur")).toBeNull();
    expect(transport.calls("GET /api/v1/organizations")).toHaveLength(0);
  });

  it("tells a person without memberships what to do", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: profileFixture() }),
    });
    renderApp({ route: "/organizaciones" });
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
    renderApp({ route: "/organizaciones" });
    expect(
      await screen.findByRole("link", { name: "Crear organización" }),
    ).toHaveProperty("href", expect.stringContaining("/organizaciones/nueva"));
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
    renderApp({ route: "/organizaciones/nueva" });
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
    expect(screen.getByRole("status").textContent).toContain(
      "solo si tú eres su primer administrador",
    );
    expect(window.location.pathname).toBe("/organizaciones");
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

  it("asks for no user or group fields to create an organization", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizaciones/nueva" });
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
    renderApp({ route: "/organizaciones/nueva" });
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
    expect(window.location.pathname).toBe("/organizaciones/nueva");
  });

  it("validates slug and administrator RUT before sending and focuses the first invalid field", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/organizaciones/nueva" });
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
    renderApp({ route: "/organizaciones/nueva" });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No tienes permiso para crear organizaciones",
    );
    expect(screen.queryByLabelText("Nombre de la organización")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Crear organización" }),
    ).toBeNull();
  });
});

describe("organization detail (view mode)", () => {
  it("shows name, slug and description disabled and, for a member, no people controls", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({ memberships: [membership(north, "USER")] }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations": () =>
        jsonResponse({
          organizations: [
            {
              ...north,
              description: "Sede central",
              enabled: true,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
          ],
        }),
    });
    renderApp({ route: "/organizaciones/org-1" });
    const name = (await screen.findByLabelText(
      "Nombre de la organización",
    )) as HTMLInputElement;
    expect(name.value).toBe("Academia Norte");
    expect(name.disabled).toBe(true);
    const slug = screen.getByLabelText(
      "Identificador (slug)",
    ) as HTMLInputElement;
    expect(slug.value).toBe("norte");
    expect(slug.disabled).toBe(true);
    const description = (await screen.findByDisplayValue(
      "Sede central",
    )) as HTMLInputElement;
    expect(description.disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Ver grupos" })).toHaveProperty(
      "href",
      expect.stringContaining("/organizaciones/org-1/grupos"),
    );
    expect(screen.queryByLabelText(/RUT de la persona/)).toBeNull();
    expect(
      transport.requests.filter(({ path }) =>
        /\/(memberships|users)$/.test(path),
      ),
    ).toEqual([]);
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
    renderApp({ route: "/organizaciones/org-9" });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Página no encontrada",
      }),
    ).toBeTruthy();
  });
});
