import { expect, test } from "../support/test.ts";
import { Api } from "../support/api.ts";
import { ALL_FLAGS, createScenario, unique } from "../support/scenario.ts";

interface ListedInvoice {
  businessId: string;
  amountPesos: number;
  groupId: string | null;
  organizationId: string;
}

test.describe("create an invoice", () => {
  test("creates 12500 pesos in the organization scope and in a group scope", async ({
    page,
    app,
  }) => {
    // A private organization: the seeded invoices must stay untouched.
    const s = await createScenario({
      members: 1,
      groups: 1,
      memberFlags: ALL_FLAGS,
    });
    try {
      const [member] = s.members;
      const [group] = s.groups;
      const token = unique();
      const organizationInvoice = `ORG-${token}`;
      const groupInvoice = `GRP-${token}`;

      await app.openAs(member.credentials, "/invoices");
      await page.getByRole("link", { name: "Nueva factura" }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Nueva factura" }),
      ).toBeVisible();

      const fill = async (businessId: string) => {
        await page.getByLabel("Número de factura").fill(businessId);
        await page.getByLabel("Proveedor").fill("Proveedor e2e");
        await page.getByLabel("Monto en pesos (CLP)").fill("12.500");
        await page.getByLabel("Fecha de emisión").fill("2026-10-25");
        await page.getByLabel("Fecha de vencimiento").fill("2026-11-25");
      };

      // Organization scope (the default).
      await fill(organizationInvoice);
      await app.shot("invoice-create-form");
      await page.getByRole("button", { name: "Crear factura" }).click();
      await expect(
        page.getByRole("heading", { name: "Factura creada" }),
      ).toBeVisible();
      await app.shot("invoice-created");

      // A group scope: the group joins the selector once the API lists it.
      await page.getByRole("button", { name: "Crear otra" }).click();
      await fill(groupInvoice);
      await page
        .getByLabel("Alcance de la factura")
        .selectOption({ label: group.name });
      await page.getByRole("button", { name: "Crear factura" }).click();
      await expect(
        page.getByRole("heading", { name: "Factura creada" }),
      ).toBeVisible();

      // The API holds exactly that amount and the chosen scope.
      const reader = await Api.signIn(member.credentials);
      try {
        const { items } = await reader.call<{ items: ListedInvoice[] }>(
          "get",
          `/invoices?organizationId=${s.org.id}&pageSize=50`,
        );
        const byId = (businessId: string) =>
          items.filter((item) => item.businessId === businessId);
        expect(byId(organizationInvoice)).toEqual([
          expect.objectContaining({
            amountPesos: 12500,
            groupId: null,
            organizationId: s.org.id,
          }),
        ]);
        expect(byId(groupInvoice)).toEqual([
          expect.objectContaining({
            amountPesos: 12500,
            groupId: group.id,
            organizationId: s.org.id,
          }),
        ]);
      } finally {
        await reader.dispose();
      }

      // And the inbox shows both, one per creation (no duplicates).
      await page.getByRole("link", { name: "Ir a facturas" }).click();
      await expect(
        page.getByRole("link", { name: organizationInvoice }),
      ).toHaveCount(1);
      await expect(page.getByRole("link", { name: groupInvoice })).toHaveCount(
        1,
      );
    } finally {
      await s.dispose();
    }
  });
});
