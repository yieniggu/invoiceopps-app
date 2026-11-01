import { request } from "@playwright/test";

import { expect, test } from "../support/test.ts";
import { BASE_URL } from "../support/env.ts";
import { expectSecretAbsent } from "../support/secrets.ts";
import { ALL_FLAGS, createScenario, unique } from "../support/scenario.ts";

// This spec shows a bearer secret the server generated. Playwright's failure
// screenshot and trace (DOM snapshots and the network log with the response
// bodies) are not masked, so a failure here would keep that secret in
// `test-results/`: both are off for this file (`test.use` cannot be scoped to
// a describe). The ARIA snapshot of a failure is dropped by the global
// teardown. See LOCAL_RUN.md.
test.use({ screenshot: "off", trace: "off" });

test("emits an API token in the UI, uses it as a bearer and loses access once revoked", async ({
  page,
  app,
}) => {
  // A private organization: the seeded invoices must stay untouched.
  const s = await createScenario({
    members: 1,
    memberFlags: ALL_FLAGS,
  });
  // No cookie jar: only the bearer secret authenticates these requests.
  const bearer = await request.newContext({ baseURL: BASE_URL });
  try {
    const [member] = s.members;
    const token = unique();
    const name = `Integración ${token}`;

    await app.openAs(member.credentials, "/api-tokens");
    await expect(
      page.getByRole("heading", { level: 1, name: "Tokens de API" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Emitir token" }).click();

    const form = page.getByRole("dialog", { name: "Emitir token" });
    await form.getByLabel("Nombre del token").fill(name);
    await form.getByRole("checkbox", { name: "Leer facturas" }).check();
    await form.getByRole("checkbox", { name: "Crear facturas" }).check();
    // The real expiry (the default is the longest preset, 29 days) is shown
    // under the control, in the person's time zone.
    await expect(form.getByText(/^Vence el /)).toBeVisible();
    await expect(form.getByText("Un token dura hasta 29 días.")).toBeVisible();
    const shownExpiry = await form.getByText(/^Vence el /).innerText();
    await app.shot("api-token-form");
    await form.getByRole("button", { name: "Emitir token" }).click();

    // The secret is shown once, in a read-only field.
    const secretDialog = page.getByRole("dialog", { name: "Token emitido" });
    await expect(
      secretDialog.getByText(
        "No podrás volver a verlo. Cópialo y guárdalo en un lugar seguro.",
      ),
    ).toBeVisible();
    // The expiry the server stored is shown with the secret.
    await expect(secretDialog.getByText(/^Vence el /)).toBeVisible();
    expect(shownExpiry).toMatch(/^Vence el \d{2}-\d{2}-\d{4}/);
    const field = secretDialog.getByLabel("Token de acceso");
    await app.shot("api-token-secret", { mask: [field] });
    const secret = await field.inputValue();
    expect(secret).toMatch(/^iop_/);

    const createInvoice = (businessId: string) =>
      bearer.post("/api/v1/invoices", {
        headers: {
          Authorization: `Bearer ${secret}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
        data: {
          organizationId: s.org.id,
          businessId,
          supplierName: "Proveedor e2e",
          amountPesos: 12500,
          currency: "CLP",
          issuedOn: "2026-10-25",
          dueOn: "2026-11-25",
          businessStatus: "PENDING",
        },
      });

    expect((await createInvoice(`TOK-${token}`)).status()).toBe(201);

    // Closing the dialog drops the secret; the list shows metadata only.
    await secretDialog
      .getByRole("button", { name: "Ya guardé el token" })
      .click();
    await expect(secretDialog).toBeHidden();
    await expectSecretAbsent(page, secret);
    await page.reload();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expectSecretAbsent(page, secret);
    const row = page.locator("tr", { hasText: name });
    await expect(row.getByText("Activo")).toBeVisible();

    // Revoking in the UI ends the bearer's access.
    await row.getByRole("button", { name: `Revocar token ${name}` }).click();
    const confirm = page.getByRole("dialog", { name: "Revocar token" });
    await confirm.getByRole("button", { name: "Revocar token" }).click();
    await expect(confirm).toBeHidden();
    await expect(row.getByText("Revocado")).toBeVisible();
    await app.shot("api-token-revoked");

    expect((await createInvoice(`TOK2-${token}`)).status()).toBe(401);
  } finally {
    await bearer.dispose();
    await s.dispose();
  }
});
