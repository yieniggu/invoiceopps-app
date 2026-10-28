import { expect, test } from "../support/test.ts";
import { createScenario, freshRut, unique } from "../support/scenario.ts";
import { login } from "../support/seeded.ts";
import { people } from "../../backend/e2e/fixtures.ts";

// This spec shows a password the server generated. Playwright's failure
// screenshot and trace (DOM snapshots and the network log with the response
// bodies) are not masked, so a failure here would keep that password in
// `test-results/`: both are off for this file. The deliberate screenshot below
// masks the value (see LOCAL_RUN.md).
test.use({ screenshot: "off", trace: "off" });

test("platform wizard creates a user in four steps with an organization and a group", async ({
  page,
  app,
}) => {
  const s = await createScenario({ members: 0, groups: 1 });
  const rut = freshRut();
  const name = `Wizard ${unique()}`;
  try {
    await app.openAs(
      login(people.platform),
      `/admin/users/new?organizationId=${s.org.id}`,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Crear usuario" }),
    ).toBeVisible();

    // 1. Data
    await expect(
      page.getByRole("heading", { name: /Paso 1 de 4/ }),
    ).toBeVisible();
    await page.getByLabel("Nombre completo").fill(name);
    await page.getByLabel("RUT del usuario").fill(rut.api);
    await app.shot("admin-wizard-1-data");
    await page.getByRole("button", { name: "Siguiente" }).click();

    // 2. Organizations (preselected through the URL)
    await expect(
      page.getByRole("heading", { name: /Paso 2 de 4/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: /^Organización/ }),
    ).toHaveValue(s.org.id);
    await page.getByRole("button", { name: "Leer facturas" }).click();
    await app.shot("admin-wizard-2-organizations");
    await page.getByRole("button", { name: "Siguiente" }).click();

    // 3. Groups
    await expect(
      page.getByRole("heading", { name: /Paso 3 de 4/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Agregar a un grupo" }).click();
    await page
      .getByRole("combobox", { name: /^Grupo/ })
      .selectOption(s.groups[0].id);
    await app.shot("admin-wizard-3-groups");
    await page.getByRole("button", { name: "Siguiente" }).click();

    // 4. Summary
    await expect(
      page.getByRole("heading", { name: /Paso 4 de 4/ }),
    ).toBeVisible();
    await expect(page.getByText(name)).toBeVisible();
    await app.shot("admin-wizard-4-summary");
    await page.getByRole("button", { name: "Crear usuario" }).click();
    const dialog = page.getByRole("dialog", { name: "Contraseña temporal" });
    await expect(dialog).toBeVisible();
    // The server generated a password and the dialog shows it. Its value is
    // never read into the test (no log, no assertion message can leak it).
    const secret = dialog.locator(".secret-value");
    await expect(secret).not.toBeEmpty();
    // The screenshot is an artifact: the password is painted over.
    await app.shot("admin-wizard-temporary-password", { mask: [secret] });

    // The user really exists, with the membership and the group that were chosen.
    const { memberships } = await s.api.call<{
      memberships: Array<{
        user: { name: string; rut: string };
        groups: Array<{ groupId: string }>;
      }>;
    }>("get", `/organizations/${s.org.id}/memberships`);
    const created = memberships.find(({ user }) => user.name === name);
    expect(created, "the wizard created the user").toBeDefined();
    expect(created?.user.rut).toBe(rut.canonical);
    expect(created?.groups.map(({ groupId }) => groupId)).toEqual([
      s.groups[0].id,
    ]);

    await dialog
      .getByRole("button", { name: "Ya copié la contraseña" })
      .click();
    await expect(dialog).toBeHidden();
  } finally {
    await s.dispose();
  }
});
