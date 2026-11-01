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

/**
 * The paginator of the screen is the last visible block of its fill container
 * and sits flush with the bottom of it, however little the list has.
 *
 * - Nothing visible follows it inside the container (`.screen-fill` for a
 *   screen, `.fill-column` for a step), so no panel hangs below the pager.
 * - Its bottom edge is the container's bottom edge.
 * - The screen fills the content area (its bottom is the bottom of `main`),
 *   and when the page is shorter than the viewport, `main` reaches the
 *   viewport bottom: a short list does not leave the pager under the header.
 * - For a step with an action bar (`actionBar`), the only visible things between
 *   the step and the end of the screen are the submit button and, when there is
 *   one, a block marked `data-action-bar` (the add-members summary of the
 *   picked people) right before it. Both are the bar, right below the pager.
 *
 * Reading the geometry (not "ends near the viewport bottom") keeps the check
 * meaningful for tall pages too: there it fails as soon as anything is
 * rendered under the pager.
 */
export async function expectPagerAtBottom(
  page: Page,
  label: string,
  { actionBar = false }: { actionBar?: boolean } = {},
) {
  const pager = page.getByRole("group", { name: "Paginación" });
  await expect(pager, `${label}: pager`).toBeVisible();
  const report = await pager.evaluate((element) => {
    const inFlow = (node: Element) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.position !== "fixed" &&
        style.position !== "absolute" &&
        box.width > 0 &&
        box.height > 0
      );
    };
    const describe = (node: Element) =>
      `${node.tagName.toLowerCase()}${node.getAttribute("type") ? `[${node.getAttribute("type")}]` : ""}${node.hasAttribute("data-action-bar") ? "[action-bar]" : ""}`;
    const followers = (from: Element, until: Element) => {
      const found: string[] = [];
      for (let node: Element = from; node !== until; node = node.parentElement!)
        for (
          let next = node.nextElementSibling;
          next;
          next = next.nextElementSibling
        )
          if (inFlow(next)) found.push(describe(next));
      return found;
    };
    const container = element.closest(".screen-fill, .fill-column");
    const screen = element.closest(".screen-fill");
    const main = element.closest("main");
    if (!container || !screen || !main) return null;
    const px = (value: string) => Number.parseFloat(value) || 0;
    const containerStyle = getComputedStyle(container);
    const mainStyle = getComputedStyle(main);
    const pagerBottom = element.getBoundingClientRect().bottom;
    const root = document.scrollingElement ?? document.documentElement;
    return {
      inContainer: followers(element, container),
      afterContainer: followers(container, screen),
      gapToContainer:
        container.getBoundingClientRect().bottom -
        px(containerStyle.paddingBottom) -
        px(containerStyle.borderBottomWidth) -
        pagerBottom,
      screenToMain:
        main.getBoundingClientRect().bottom -
        px(mainStyle.paddingBottom) -
        screen.getBoundingClientRect().bottom,
      mainShortOfViewport:
        root.scrollHeight <= window.innerHeight
          ? window.innerHeight - main.getBoundingClientRect().bottom
          : 0,
    };
  });
  expect(report, `${label}: pager lives in a fill container`).not.toBeNull();
  expect(report!.inContainer, `${label}: content under the pager`).toEqual([]);
  expect(
    report!.afterContainer.filter(
      (name) => name !== "div[action-bar]" || !actionBar,
    ),
    `${label}: only the action bar may follow the step`,
  ).toEqual(actionBar ? ["button[submit]"] : []);
  expect(
    Math.abs(report!.gapToContainer),
    `${label}: pager is flush with the bottom of its container`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(report!.screenToMain),
    `${label}: the screen fills the content area`,
  ).toBeLessThanOrEqual(1);
  expect(
    report!.mainShortOfViewport,
    `${label}: a short page still reaches the viewport bottom`,
  ).toBeLessThanOrEqual(1);
}

/**
 * The add-members selection count is shown once, in the disclosure summary
 * («N personas seleccionadas · Ajustar permisos»); the status line above the
 * pager is a visually hidden live region that repeats it for screen readers.
 */
export async function expectSelectionCount(page: Page, count: number) {
  const text =
    count === 1 ? "1 persona seleccionada" : `${count} personas seleccionadas`;
  await expect(
    page.getByRole("button", { name: `${text} · Ajustar permisos` }),
  ).toBeVisible();
  const live = page.getByText(`${text}.`, { exact: true });
  await expect(live).toHaveAttribute("role", "status");
  await expect(live).toHaveClass(/visually-hidden/);
}
