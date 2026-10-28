import { expect, test } from "../support/test.ts";
import {
  E2E_PASSWORD,
  asPlatform,
  freshRut,
  people,
  unique,
} from "../support/scenario.ts";

test.describe("authentication", () => {
  test("rejects a wrong password and then signs in and out", async ({
    page,
    app,
  }) => {
    await app.open("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Iniciar sesión" }),
    ).toBeVisible();
    await app.shot("login");

    await page.getByLabel("RUT", { exact: true }).fill(people.carla.rut.api);
    await page
      .getByLabel("Contraseña", { exact: true })
      .fill("not-the-password-1");
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Revisa el RUT y la contraseña",
    );

    await page.getByLabel("RUT", { exact: true }).fill(people.carla.rut.api);
    await page.getByLabel("Contraseña", { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Panel principal" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/);

    // The drawer hides the nav on narrow screens: open it when needed.
    const menu = page.getByRole("button", { name: "Abrir menú" });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole("button", { name: "Salir" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Iniciar sesión" }),
    ).toBeVisible();
  });

  test("forces a password change on the first sign-in", async ({
    page,
    app,
  }) => {
    const rut = freshRut();
    const temporary = `Tmp-${unique()}-first`;
    const platform = await asPlatform();
    await platform.call("post", "/admin/users", {
      name: "Persona Nueva",
      rut: rut.api,
      memberships: [],
      temporaryPassword: temporary,
    });
    await platform.dispose();

    await app.open("/");
    await page.getByLabel("RUT", { exact: true }).fill(rut.api);
    await page.getByLabel("Contraseña", { exact: true }).fill(temporary);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Cambia tu contraseña temporal",
      }),
    ).toBeVisible();
    await app.shot("change-password-forced");

    await page
      .getByLabel("Contraseña temporal", { exact: true })
      .fill(temporary);
    await page
      .getByLabel("Contraseña nueva", { exact: true })
      .fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Cambiar contraseña" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Panel principal" }),
    ).toBeVisible();
  });
});
