import { expect, test } from "../support/test.ts";
import { sidebarNav } from "../support/layout.ts";
import { login, organizations, people, seededIds } from "../support/seeded.ts";

const openMenuIfNeeded = async (page: import("@playwright/test").Page) => {
  const menu = page.getByRole("button", { name: "Abrir menú" });
  // Phones keep the navigation in a drawer behind this button.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if (await menu.isVisible()) await menu.click();
};

test.describe("authorization", () => {
  test("a plain member does not see administration links or screens", async ({
    page,
    app,
  }) => {
    const ids = await seededIds();
    await app.openAs(login(people.acmeUser), `/organizations/${ids.acme.id}`);
    await expect(
      page.getByRole("heading", { level: 1, name: organizations.acme.name }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Agregar miembro" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Miembros" })).toHaveCount(0);
    // The page's own link (the sidebar has one of the same name).
    await expect(
      page.getByRole("main").getByRole("link", { name: "Grupos" }),
    ).toBeVisible();
    await openMenuIfNeeded(page);
    await expect(
      sidebarNav(page).getByRole("link", { name: "Admin", exact: true }),
    ).toHaveCount(0);

    await page.goto(`/organizations/${ids.acme.id}/members`);
    await expect(page.getByRole("alert")).toContainText(
      "Solo los administradores de la organización pueden ver a sus miembros.",
    );
    await app.shot("members-forbidden");

    await page.goto(`/organizations/${ids.acme.id}/members/new`);
    await expect(page.getByRole("alert")).toContainText(
      "Solo los administradores",
    );

    await page.goto("/admin/users/new");
    await expect(
      page.getByRole("heading", { level: 1, name: "Página no encontrada" }),
    ).toBeVisible();
  });

  test("a member of another organization gets not found", async ({
    page,
    app,
  }) => {
    const ids = await seededIds();
    await app.openAs(
      login(people.betaAdmin),
      `/organizations/${ids.acme.id}/members`,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Página no encontrada" }),
    ).toBeVisible();
  });

  test("an organization admin sees member management but not the platform admin", async ({
    page,
    app,
  }) => {
    const ids = await seededIds();
    await app.openAs(login(people.acmeAdmin), `/organizations/${ids.acme.id}`);
    await expect(
      page.getByRole("link", { name: "Agregar miembro" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Miembros" })).toBeVisible();
    await openMenuIfNeeded(page);
    await expect(
      sidebarNav(page).getByRole("link", { name: "Admin", exact: true }),
    ).toHaveCount(0);
    await page.goto("/admin/users/new");
    await expect(
      page.getByRole("heading", { level: 1, name: "Página no encontrada" }),
    ).toBeVisible();
  });

  test("the platform administrator sees the Admin entry", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.platform), "/dashboard");
    await openMenuIfNeeded(page);
    await expect(
      sidebarNav(page).getByRole("link", { name: "Admin", exact: true }),
    ).toBeVisible();
  });
});
