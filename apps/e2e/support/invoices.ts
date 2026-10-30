import { expect, type Page } from "@playwright/test";

const SCOPE_LABEL = "Ver facturas de";

/**
 * Picks a group in the invoice scope selector by its option value, looked up
 * inside the organization's optgroup (or the single-organization «Grupos»
 * one). A label alone is ambiguous as soon as two organizations have a group
 * of the same name.
 */
export async function selectGroupScope(
  page: Page,
  { organization, group }: { organization: string; group: string },
) {
  const select = page.getByLabel(SCOPE_LABEL);
  await expect(select).toBeVisible();
  const exact = new RegExp(`^${group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const inOrganization = select
    .locator(`optgroup[label="${organization}"] option`)
    .filter({ hasText: exact });
  const inGroups = select
    .locator('optgroup[label="Grupos"] option')
    .filter({ hasText: exact });
  // The group options arrive after the organization's groups load: wait for
  // exactly one match across both optgroups before reading any of them (a
  // one-shot count could pick the wrong, still-empty locator).
  const option = inOrganization.or(inGroups);
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  expect(value, `option value of ${group}`).toMatch(/^group:/);
  await select.selectOption(value!);
}
