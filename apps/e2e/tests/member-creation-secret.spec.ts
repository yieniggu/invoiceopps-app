import { expect, test } from "../support/test.ts";
import { createScenario, freshRut, unique } from "../support/scenario.ts";

// This spec shows a password the server generated. Playwright's failure
// screenshot and trace (DOM snapshots and the network log with the response
// bodies) are not masked, so a failure here would keep that password in
// `test-results/`: both are off for this file (`test.use` cannot be scoped to
// a describe). See LOCAL_RUN.md.
test.use({ screenshot: "off", trace: "off" });

test("an organization admin creates a person in place, without the platform link", async ({
  page,
  app,
}) => {
  const s = await createScenario({ members: 0 });
  const rut = freshRut();
  const name = `Creada ${unique()}`;
  try {
    await app.openAs(
      s.admin.credentials,
      `/organizations/${s.org.id}/members/new`,
    );
    await page.getByRole("tab", { name: "Crear persona nueva" }).click();
    await expect(
      page.getByRole("link", { name: /asistente de administración/ }),
    ).toHaveCount(0);

    await page.getByLabel("Nombre completo").fill(name);
    await page.getByLabel("RUT del usuario").fill(rut.api);
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(
      page.getByRole("heading", { name: /Paso 2 de 4/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(
      page.getByRole("heading", { name: /Paso 3 de 4/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(
      page.getByRole("heading", { name: /Paso 4 de 4/ }),
    ).toBeVisible();
    await app.shot("add-member-new-summary");
    await page.getByRole("button", { name: "Crear usuario" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "Ya copié la contraseña" })
      .click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText(/creado y agregado a la organización/),
    ).toBeVisible();
  } finally {
    await s.dispose();
  }
});
