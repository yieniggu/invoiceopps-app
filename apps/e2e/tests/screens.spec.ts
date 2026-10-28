import { expect, test } from "../support/test.ts";
import {
  login,
  organizations,
  people,
  seededGroups,
  seededIds,
} from "../support/seeded.ts";

const heading = (
  page: import("@playwright/test").Page,
  name: string | RegExp,
) => page.getByRole("heading", { level: 1, name });

// Read-only tour of every screen against the seeded fixtures. Each screen is
// opened by URL, asserted by its page title and saved as a full-page screenshot
// (the layout guards run inside `app.shot`).
test.describe("screen tour (seeded data)", () => {
  test("member screens", async ({ page, app }) => {
    const ids = await seededIds();
    await app.openAs(login(people.carla), "/dashboard");
    await expect(heading(page, "Panel principal")).toBeVisible();
    await app.shot("dashboard");

    await page.goto("/profile");
    await expect(heading(page, "Mi perfil")).toBeVisible();
    await expect(
      page.getByRole("main").getByText(people.carla.name, { exact: true }),
    ).toBeVisible();
    await app.shot("profile");

    await page.goto("/organizations");
    await expect(heading(page, "Organizaciones")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: organizations.acme.name }),
    ).toBeVisible();
    await app.shot("organizations-list");

    await page.goto(`/organizations/${ids.acme.id}`);
    await expect(heading(page, organizations.acme.name)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
    await app.shot("organization-summary-member");

    await page.goto("/groups");
    await expect(heading(page, "Grupos")).toBeVisible();
    await app.shot("my-groups");

    await page.goto(`/organizations/${ids.acme.id}/groups`);
    await expect(heading(page, "Grupos de la organización")).toBeVisible();
    await app.shot("organization-groups-member");

    await page.goto(
      `/organizations/${ids.acme.id}/groups/${ids.groups.accounting}`,
    );
    await expect(heading(page, seededGroups.accounting.name)).toBeVisible();
    await app.shot("group-summary-member");

    await page.goto("/policies");
    await expect(heading(page, "Políticas")).toBeVisible();
    await expect(page.getByText("No disponible por ahora.")).toBeVisible();
    await app.shot("policies");

    await page.goto("/nothing-here");
    await expect(heading(page, "Página no encontrada")).toBeVisible();
    await app.shot("not-found");
  });

  test("administrator screens", async ({ page, app }) => {
    const ids = await seededIds();
    await app.openAs(login(people.acmeAdmin), `/organizations/${ids.acme.id}`);
    await expect(heading(page, organizations.acme.name)).toBeVisible();
    await expect(
      page.getByRole("main").getByRole("link", { name: "Miembros" }),
    ).toBeVisible();
    await app.shot("organization-summary-admin");

    await page.goto(`/organizations/${ids.acme.id}/members`);
    await expect(heading(page, "Miembros")).toBeVisible();
    await expect(
      page.getByRole("link", { name: people.carla.name }),
    ).toBeVisible();
    await app.shot("organization-members");

    await page.goto(`/organizations/${ids.acme.id}/members/${ids.users.carla}`);
    await expect(heading(page, people.carla.name)).toBeVisible();
    await app.shot("organization-member");

    await page.goto(`/organizations/${ids.acme.id}/members/new`);
    await expect(heading(page, "Agregar miembro")).toBeVisible();
    await app.shot("add-member-existing");
    await page.getByRole("tab", { name: "Crear persona nueva" }).click();
    await expect(
      page.getByRole("heading", { name: "Crear usuario nuevo" }),
    ).toBeVisible();
    await app.shot("add-member-new");

    await page.goto(
      `/organizations/${ids.acme.id}/members/permissions?userIds=${ids.users.carla},${ids.users.diego}`,
    );
    await expect(heading(page, "Editar permisos en bloque")).toBeVisible();
    await app.shot("organization-bulk-permissions");

    await page.goto(`/organizations/${ids.acme.id}/groups`);
    await expect(heading(page, "Grupos de la organización")).toBeVisible();
    await app.shot("organization-groups-admin");

    const group = `/organizations/${ids.acme.id}/groups/${ids.groups.accounting}`;
    await page.goto(group);
    await expect(heading(page, seededGroups.accounting.name)).toBeVisible();
    await app.shot("group-summary-admin");

    await page.goto(`${group}/members`);
    await expect(heading(page, "Miembros del grupo")).toBeVisible();
    await app.shot("group-members");

    await page.goto(`${group}/members/${ids.users.carla}`);
    await expect(heading(page, people.carla.name)).toBeVisible();
    await app.shot("group-member");

    await page.goto(
      `${group}/members/permissions?userIds=${ids.users.carla},${ids.users.diego}`,
    );
    await expect(heading(page, "Editar permisos en bloque")).toBeVisible();
    await app.shot("group-bulk-permissions");

    await page.goto(
      `/organizations/${ids.acme.id}/groups/${ids.groups.operations}/members/new`,
    );
    await expect(heading(page, "Agregar miembros al grupo")).toBeVisible();
    await app.shot("group-add-members");

    await page.goto(`/organizations/${ids.acme.id}/groups/new`);
    await expect(heading(page, "Crear grupo")).toBeVisible();
    await app.shot("group-new");
  });

  test("platform administrator screens", async ({ page, app }) => {
    await app.openAs(login(people.platform), "/organizations");
    await expect(heading(page, "Organizaciones")).toBeVisible();
    await app.shot("platform-organizations");

    await page.goto("/organizations/new");
    await expect(heading(page, "Crear organización")).toBeVisible();
    await app.shot("organization-new");
  });

  test("invoices", async ({ page, app }) => {
    await app.openAs(login(people.carla), "/invoices");
    await expect(heading(page, "Facturas")).toBeVisible();
    // The seeded group's list, not whichever state the page happens to be in.
    await page
      .getByLabel("Propietario")
      .selectOption({ label: "Acme Logística · Grupo: Contabilidad" });
    for (const businessId of ["FAC-1001", "FAC-1002", "FAC-1003"]) {
      await expect(
        page.getByRole("button", { name: `Ver ${businessId}` }),
      ).toBeVisible();
    }
    await app.shot("invoices-list-tour");
  });
});
