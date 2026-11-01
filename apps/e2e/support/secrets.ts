import { expect, type Page } from "@playwright/test";

/**
 * The secret is nowhere on the page: not in the text, not in the markup and,
 * above all, not in the value of any field. `getByText` never matches an
 * `<input value>` (the value is a property, not a text node), so asserting
 * only with it passes even while the secret sits in a field.
 */
export async function expectSecretAbsent(page: Page, secret: string) {
  const values = await page
    .locator("input, textarea")
    .evaluateAll((elements) =>
      elements.map(
        (element) => (element as HTMLInputElement | HTMLTextAreaElement).value,
      ),
    );
  expect(
    values.filter((value) => value.includes(secret)),
    "a field still holds the secret",
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.body.innerText),
    "the page text shows the secret",
  ).not.toContain(secret);
  expect(await page.content(), "the markup carries the secret").not.toContain(
    secret,
  );
}
