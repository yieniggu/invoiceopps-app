import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import type { Api } from "./api.ts";

/**
 * Creates `count` invoices in the organization scope through the real API (one
 * request each, with its own idempotency key), numbered `${prefix}-001`….
 * Enough of them make the inbox span several pages.
 */
export async function seedInvoices(
  api: Api,
  organizationId: string,
  count: number,
  prefix: string,
) {
  for (let index = 1; index <= count; index += 1) {
    await api.call(
      "post",
      "/invoices",
      {
        organizationId,
        businessId: `${prefix}-${String(index).padStart(3, "0")}`,
        supplierName: "Proveedor e2e",
        amountPesos: 1000 + index,
        currency: "CLP",
        issuedOn: "2026-10-01",
        dueOn: "2026-11-01",
        businessStatus: "PENDING",
      },
      { "Idempotency-Key": randomUUID() },
    );
  }
}

/** Accessible names of the two inbox selects. */
export const ORGANIZATION_SELECT = "Organización";
export const GROUP_SELECT = "Grupo";

/**
 * Picks the organization and then one of its groups in the inbox selects. The
 * organization is chosen by its exact name (changing it resets the group); the
 * group option arrives once the organization's groups load, so wait for exactly
 * one match before reading its value. A label alone would be ambiguous across
 * organizations, which is why the organization is chosen first.
 */
export async function selectGroupScope(
  page: Page,
  { organization, group }: { organization: string; group: string },
) {
  const organizationSelect = page.getByLabel(ORGANIZATION_SELECT, {
    exact: true,
  });
  await expect(organizationSelect).toBeVisible();
  await organizationSelect.selectOption({ label: organization });
  const select = page.getByLabel(GROUP_SELECT, { exact: true });
  const exact = new RegExp(`^${group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const option = select.locator("option").filter({ hasText: exact });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  expect(value, `option value of ${group}`).toMatch(/^group:/);
  await select.selectOption(value!);
}
