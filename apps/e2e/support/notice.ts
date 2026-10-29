import type { Locator, Page } from "@playwright/test";

/**
 * The visible notice card (the Toast). Its text is also written into the
 * shell's visually hidden live region so screen readers announce it; the
 * visible copy is the one a person reads, so tests look it up here.
 */
export const notice = (page: Page, text: string | RegExp): Locator =>
  page.locator(".toast").getByText(text);
