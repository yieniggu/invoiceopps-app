import { expect, type Page } from "@playwright/test";

/**
 * The secret is nowhere on the page: not in the text, not in the markup and,
 * above all, not in the value of any field. `getByText` never matches an
 * `<input value>` (the value is a property, not a text node), so asserting
 * only with it passes even while the secret sits in a field.
 *
 * Every check compares booleans: a failure names where the secret was found
 * but never echoes the secret (or the text around it) into the console or a
 * CI log.
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
    values.some((value) => value.includes(secret)),
    "a field still holds the secret",
  ).toBe(false);
  expect(
    (await page.evaluate(() => document.body.innerText)).includes(secret),
    "the page text shows the secret",
  ).toBe(false);
  expect(
    (await page.content()).includes(secret),
    "the markup carries the secret",
  ).toBe(false);
}

/** `text` does not contain `secret`; a failure never prints either of them. */
export function expectTextWithoutSecret(
  text: string,
  secret: string,
  where: string,
) {
  expect(text.includes(secret), `${where} carries the secret`).toBe(false);
}
