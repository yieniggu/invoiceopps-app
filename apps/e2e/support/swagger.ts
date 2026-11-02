import type { Locator, Page } from "@playwright/test";

import { expect } from "./test.ts";

/** The Swagger UI operation block of `method` and the exact `path`. */
export function operation(page: Page, method: string, path: string): Locator {
  return page.locator(`.opblock-${method}`).filter({
    has: page.locator(`.opblock-summary-path[data-path="${path}"]`),
  });
}

export async function openOperation(block: Locator) {
  if (!(await block.evaluate((node) => node.classList.contains("is-open"))))
    await block.locator(".opblock-summary-control").click();
  await block.getByRole("button", { name: "Try it out" }).click();
}

/** Clears any earlier response so a new one cannot be mistaken for it. */
export async function execute(block: Locator) {
  const clear = block.getByRole("button", { name: "Clear" });
  if (await clear.count()) await clear.click();
  await expect(block.locator(".live-responses-table")).toHaveCount(0);
  await block.getByRole("button", { name: "Execute" }).click();
}

export function liveStatus(block: Locator) {
  return block
    .locator(".live-responses-table tr.response .response-col_status")
    .first();
}

export function liveBody(block: Locator) {
  return block.locator(
    ".live-responses-table tr.response .response-col_description pre",
  );
}

export async function liveJson<T>(block: Locator): Promise<T> {
  await expect(liveBody(block).first()).toBeVisible();
  return JSON.parse((await liveBody(block).first().innerText()).trim()) as T;
}

/** Authorize with the bearer scheme only, then close the dialog. */
export async function authorizeBearer(page: Page, secret: string) {
  await page.getByRole("button", { name: "Authorize" }).click();
  const dialog = page.locator(".dialog-ux .modal-ux");
  const bearer = dialog.locator(".auth-container", { hasText: "bearerAuth" });
  await bearer.locator("input[type=text]").fill(secret);
  await bearer.getByRole("button", { name: "Apply credentials" }).click();
  await expect(bearer.getByText("Authorized")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator(".scheme-container .btn.authorize.locked"),
  ).toBeVisible();
}
