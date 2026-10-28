import { expect, test } from "../support/test.ts";
import { createScenario } from "../support/scenario.ts";
import { login, people } from "../support/seeded.ts";

test.describe("invoices", () => {
  test("lists, searches and opens the detail of a group's invoices", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.carla), "/invoices");
    await page
      .getByLabel("Propietario")
      .selectOption({ label: "Acme Logística · Grupo: Contabilidad" });
    await expect(
      page.getByRole("button", { name: "Ver FAC-1001" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Ver FAC-1002" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Ver FAC-1003" }),
    ).toBeVisible();
    await app.shot("invoices-list");

    await page.getByLabel("Buscar por ID o proveedor").fill("Pacífico");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(
      page.getByRole("button", { name: "Ver FAC-1002" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Ver FAC-1001" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Ver FAC-1002" }).click();
    await expect(page.getByText("Servicios Pacífico Ltda")).toBeVisible();
    await expect(page.getByRole("heading", { name: "FAC-1002" })).toBeVisible();
    await app.shot("invoice-detail");
    await page.getByRole("button", { name: "Volver a facturas" }).click();
    await expect(page.getByLabel("Buscar por ID o proveedor")).toBeVisible();
  });

  test("a member without a group sees the empty state", async ({
    page,
    app,
  }) => {
    // Elena belongs to Acme but to none of its groups (see the seed), so the
    // only owner she can pick is her own work and it has no invoices.
    await app.openAs(login(people.elena), "/invoices");
    await expect(
      page.getByRole("heading", { level: 1, name: "Facturas" }),
    ).toBeVisible();
    const owner = page.getByLabel("Propietario");
    // No group of hers to pick: only her own work in Acme.
    await expect(owner.locator("option")).toHaveText([
      "Selecciona un propietario",
      "Acme Logística · Individual",
    ]);
    await expect(
      page.getByText("Acme Logística · Trabajo individual"),
    ).toBeVisible();
    await expect(
      page.getByText("No hay facturas para este propietario."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Ver FAC-/ })).toHaveCount(
      0,
    );
    await app.shot("invoices-member-without-group");
  });

  test("a person who belongs to no organization is told so", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.loner), "/invoices");
    await expect(
      page.getByText("No tienes organizaciones para consultar facturas."),
    ).toBeVisible();
    await app.shot("invoices-no-organization");
  });
});

test.describe("profile", () => {
  test("shows the identity and saves contact data", async ({ page, app }) => {
    // A person of its own: saving contact data must not touch a seeded fixture.
    const s = await createScenario({ members: 1 });
    try {
      const [person] = s.members;
      await app.openAs(person.credentials, "/profile");
      await expect(
        page.getByRole("heading", { level: 2, name: "Identidad" }),
      ).toBeVisible();
      await page.getByLabel("Correo electrónico").fill("persona@example.com");
      await page.getByLabel("Nombre de usuario").fill("persona.prueba");
      await page.getByRole("button", { name: "Guardar cambios" }).click();
      await expect(page.getByText("Perfil actualizado.")).toBeVisible();
      await page.reload();
      await expect(page.getByLabel("Correo electrónico")).toHaveValue(
        "persona@example.com",
      );
      await app.shot("profile-saved");
    } finally {
      await s.dispose();
    }
  });

  test("the change-password route is only for forced changes", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.felipe), "/change-password");
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
