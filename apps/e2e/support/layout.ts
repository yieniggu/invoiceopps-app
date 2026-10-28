import { expect, type Locator, type Page } from "@playwright/test";

/** The element's text sits on one line (no wrapping, so no mid-word breaks). */
export async function expectSingleLine(locator: Locator) {
  const lines = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops = new Set(
      [...range.getClientRects()]
        .filter((rect) => rect.width > 0)
        .map((rect) => Math.round(rect.top)),
    );
    return tops.size;
  });
  expect(lines, "text wraps over several lines").toBe(1);
}

/** The Políticas entry: label on one line with the badge under it. */
export async function expectPoliciesItemLayout(page: Page) {
  const item = page.getByRole("button", { name: /^Políticas/ });
  const label = item.locator(".nav-label");
  await expect(label).toHaveText("Políticas");
  await expectSingleLine(label);
  const labelBox = await label.boundingBox();
  const badgeBox = await item.locator(".nav-badge").boundingBox();
  expect(labelBox && badgeBox).toBeTruthy();
  // Badge below the label, not beside it.
  expect(badgeBox!.y).toBeGreaterThanOrEqual(
    labelBox!.y + labelBox!.height - 1,
  );
  const itemBox = await item.boundingBox();
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(
    itemBox!.x + itemBox!.width + 1,
  );
}

/** Every sidebar label (links and buttons) stays on one line. */
export async function expectSidebarLabelsSingleLine(page: Page) {
  const labels = page.locator("#app-sidebar .nav-label");
  const count = await labels.count();
  expect(count).toBeGreaterThan(3);
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    if (await label.isVisible()) await expectSingleLine(label);
  }
}

/** Permission toggles carry no state words: aria-pressed and the icon do. */
export async function expectNoStateWordsInToggles(page: Page) {
  const toggles = page.locator(".permission-toggle");
  expect(await toggles.count()).toBeGreaterThan(0);
  for (const text of await toggles.allTextContents()) {
    expect(text).not.toMatch(/Activado|Desactivado/);
  }
}

/** The primary navigation (sidebar or drawer). */
export const sidebarNav = (page: Page) =>
  page.getByRole("navigation", { name: "Navegación principal" });
