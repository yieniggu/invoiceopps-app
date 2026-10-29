import type { Page } from "@playwright/test";

import { expect, test } from "../support/test.ts";
import {
  E2E_PASSWORD,
  asPlatform,
  createScenario,
  freshRut,
  people,
  unique,
} from "../support/scenario.ts";
import { login } from "../support/seeded.ts";
import { notice } from "../support/notice.ts";

// Two tests here read a temporary password the server generated. Playwright's
// failure screenshot and trace (DOM snapshots and the network log with the
// response bodies) are not masked, so a failure would keep it in
// `test-results/`: both are off for this file (`test.use` cannot be scoped to
// a describe). See LOCAL_RUN.md.
test.use({ screenshot: "off", trace: "off" });

const h1 = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

/** Signs in through the login form, like a person would. */
async function signInThroughForm(
  page: Page,
  credentials: { rut: string; password: string },
) {
  await page.goto("/");
  await page.getByLabel("RUT", { exact: true }).fill(credentials.rut);
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill(credentials.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

/** The id of a person, found as the platform administrator does (RUT search). */
async function userIdOf(canonicalRut: string) {
  const platform = await asPlatform();
  try {
    const { users } = await platform.call<{ users: Array<{ id: string }> }>(
      "get",
      `/admin/users?search=${canonicalRut}`,
    );
    expect(users, "exactly one person has that RUT").toHaveLength(1);
    return users[0].id;
  } finally {
    await platform.dispose();
  }
}

test.describe("platform user administration", () => {
  test("creates a user, resets the password and the user signs in and must change it", async ({
    page,
    app,
  }) => {
    const rut = freshRut();
    const name = `Restablecida ${unique()}`;

    // 1. Create the user with the wizard (no organization, no group).
    await app.openAs(login(people.platform), "/admin/users/new");
    await page.getByLabel("Nombre completo").fill(name);
    await page.getByLabel("RUT del usuario").fill(rut.api);
    for (const step of [2, 3, 4]) {
      await page.getByRole("button", { name: "Siguiente" }).click();
      await expect(
        page.getByRole("heading", { name: new RegExp(`Paso ${step} de 4`) }),
      ).toBeVisible();
    }
    await page.getByRole("button", { name: "Crear usuario" }).click();
    const created = page.getByRole("dialog", { name: "Contraseña temporal" });
    await expect(created).toBeVisible();
    await created
      .getByRole("button", { name: "Ya copié la contraseña" })
      .click();
    await expect(created).toBeHidden();

    // 2. Reset the password from the person's page and read the new one.
    const userId = await userIdOf(rut.canonical);
    await page.goto(`/admin/users/${userId}`);
    await expect(h1(page, name)).toBeVisible();
    await page.getByRole("button", { name: "Restablecer contraseña" }).click();
    await page
      .getByRole("button", { name: "Confirmar restablecimiento" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Contraseña temporal" });
    await expect(dialog).toBeVisible();
    const secret = dialog.locator(".secret-value");
    await expect(secret).not.toBeEmpty();
    const temporary = (await secret.textContent())?.trim() ?? "";
    expect(temporary.length).toBeGreaterThan(8);
    await dialog
      .getByRole("button", { name: "Ya copié la contraseña" })
      .click();
    await expect(dialog).toBeHidden();

    // 3. The person signs in with it and is forced to change it.
    await page.context().clearCookies();
    await signInThroughForm(page, { rut: rut.api, password: temporary });
    await expect(h1(page, "Cambia tu contraseña temporal")).toBeVisible();
    await page
      .getByLabel("Contraseña temporal", { exact: true })
      .fill(temporary);
    await page
      .getByLabel("Contraseña nueva", { exact: true })
      .fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Cambiar contraseña" }).click();
    await expect(h1(page, "Panel principal")).toBeVisible();
  });

  test("deactivates a user (login fails like invalid credentials) and reactivates them", async ({
    page,
    app,
  }) => {
    const s = await createScenario({ members: 1 });
    try {
      const [member] = s.members;
      const userPage = `/admin/users/${member.id}`;

      await app.openAs(login(people.platform), userPage);
      await expect(h1(page, member.name)).toBeVisible();
      await page
        .getByRole("button", { name: "Desactivar", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Confirmar desactivación" })
        .click();
      await expect(page.getByText("Cuenta desactivada.")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Reactivar", exact: true }),
      ).toBeVisible();

      // Same message as a wrong password: the screen does not reveal why.
      await page.context().clearCookies();
      await signInThroughForm(page, member.credentials);
      await expect(page.getByRole("alert")).toContainText(
        "Revisa el RUT y la contraseña",
      );
      await expect(h1(page, "Iniciar sesión")).toBeVisible();

      await app.openAs(login(people.platform), userPage);
      await page
        .getByRole("button", { name: "Reactivar", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Confirmar reactivación" })
        .click();
      await expect(page.getByText("Cuenta reactivada.")).toBeVisible();

      await page.context().clearCookies();
      await signInThroughForm(page, member.credentials);
      await expect(h1(page, "Panel principal")).toBeVisible();
    } finally {
      await s.dispose();
    }
  });

  test("finds a seeded user in the directory by a RUT fragment", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.platform), "/admin");
    await expect(h1(page, "Administración")).toBeVisible();
    // The body of Carla Soto's RUT, typed the way people write it (dots).
    const body = people.carla.rut.api.split("-")[0];
    const formatted = body.replace(/(\d)(?=(\d{3})+$)/g, "$1.");
    await page.getByLabel("Buscar por nombre o RUT").fill(formatted);
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page).toHaveURL(/search=/);
    const table = page.getByRole("table", {
      name: "Usuarios de la plataforma",
    });
    await expect(
      table.getByRole("link", { name: people.carla.name }),
    ).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(2); // header + one person
  });
});

test.describe("organizations and people beyond the administrator's own", () => {
  test("the platform administrator opens and edits an organization they do not belong to", async ({
    page,
    app,
  }) => {
    const s = await createScenario({ members: 1 });
    try {
      await app.openAs(
        login(people.platform),
        `/organizations?search=${encodeURIComponent(s.org.name)}`,
      );
      await expect(
        page.getByRole("heading", { level: 2, name: s.org.name }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: `Ver detalle de ${s.org.name}` })
        .click();
      await expect(h1(page, s.org.name)).toBeVisible();

      await page.getByRole("link", { name: "Editar organización" }).click();
      await expect(h1(page, "Editar organización")).toBeVisible();
      const renamed = `${s.org.name} editada`;
      await page.getByLabel("Nombre de la organización").fill(renamed);
      await page.getByRole("button", { name: "Guardar cambios" }).click();

      await expect(notice(page, "Organización actualizada.")).toBeVisible();
      await expect(h1(page, renamed)).toBeVisible();
      // The slug is immutable.
      await expect(page.locator(".slug").first()).toHaveText(s.org.slug);
    } finally {
      await s.dispose();
    }
  });

  test("a plain member sees the reduced member list and opens a co-member's profile", async ({
    page,
    app,
  }) => {
    const s = await createScenario({ members: 2 });
    try {
      const [me, other] = s.members;
      await app.openAs(me.credentials, `/organizations/${s.org.id}/members`);
      await expect(h1(page, "Miembros")).toBeVisible();
      const table = page.getByRole("table", {
        name: "Miembros de la organización",
      });
      await expect(table.getByRole("link", { name: other.name })).toBeVisible();
      await expect(
        table.getByRole("link", { name: s.admin.name }),
      ).toBeVisible();
      // No administration: no add link, no selection, no bulk edit, no RUT.
      await expect(
        page.getByRole("link", { name: "Agregar miembro" }),
      ).toHaveCount(0);
      await expect(page.getByRole("checkbox")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Editar permisos en bloque" }),
      ).toHaveCount(0);
      await expect(table.getByText(other.rut.api)).toHaveCount(0);
      await app.shot("members-basic-list");

      await table.getByRole("link", { name: other.name }).click();
      await expect(page).toHaveURL(new RegExp(`/users/${other.id}$`));
      await expect(h1(page, other.name)).toBeVisible();
      await expect(page.getByRole("link", { name: s.org.name })).toBeVisible();
      await expect(page.getByText(other.rut.api)).toHaveCount(0);
    } finally {
      await s.dispose();
    }
  });
});
