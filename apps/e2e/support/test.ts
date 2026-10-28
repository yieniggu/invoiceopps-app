import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  expect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";

import { BASE_URL } from "./env.ts";
import type { Credentials } from "./scenario.ts";

const ARTIFACTS = resolve(import.meta.dirname, "../e2e-artifacts");

export interface App {
  /** Signs in through the API (the UI login has its own spec) and opens `path`. */
  openAs: (credentials: Credentials, path: string) => Promise<void>;
  /** Opens `path` without a session. */
  open: (path: string) => Promise<void>;
  /**
   * Full-page screenshot for human review plus the layout guards. `mask`
   * paints over elements that must not end up in an artifact (secrets).
   */
  shot: (name: string, options?: { mask?: Locator[] }) => Promise<void>;
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  expect(
    overflow.scrollWidth,
    `page scrolls horizontally (${overflow.scrollWidth} > ${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

/**
 * The page has nothing left to load: no skeleton, no "Cargando..." status and
 * the web fonts are ready. Explicit conditions instead of waiting for the
 * network to go quiet (a page can be idle while a status still says loading,
 * and a long-lived request would never go quiet).
 */
export async function expectSettled(page: Page) {
  await expect(page.locator(".session-skeleton")).toHaveCount(0);
  await expect(page.getByText(/^Cargando/)).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

/** A page signed in through the API cookie jar shared with the browser. */
export async function signInApi(page: Page, credentials: Credentials) {
  const response = await page.request.post("/api/v1/auth/login", {
    data: credentials,
    headers: { Origin: BASE_URL },
  });
  expect(response.status(), "API sign-in").toBe(200);
}

export const test = base.extend<{ app: App }>({
  app: async ({ page }, use, testInfo) => {
    const directory = resolve(ARTIFACTS, testInfo.project.name);
    mkdirSync(directory, { recursive: true });
    await use({
      open: async (path) => {
        await page.goto(path);
      },
      openAs: async (credentials, path) => {
        await signInApi(page, credentials);
        await page.goto(path);
      },
      shot: async (name, options = {}) => {
        await expectSettled(page);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({
          path: resolve(directory, `${name}.png`),
          fullPage: true,
          mask: options.mask,
          maskColor: "#000000",
        });
      },
    });
  },
});

export { expect };

/** True when the project runs at the narrow (drawer) viewport. */
export const isMobile = (projectName: string) => projectName === "mobile";
