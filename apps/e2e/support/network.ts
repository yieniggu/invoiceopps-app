import type { BrowserContext } from "@playwright/test";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * G15: everything the browser asks for stays on this machine. Records (and
 * aborts) every request of `context` whose host is not loopback, including
 * fonts, CDNs, analytics or the Swagger online validator. `data:` and `blob:`
 * URLs never reach the network and are ignored. The caller asserts the list
 * is empty at the end, so a single outbound request fails the run.
 */
export async function auditLoopbackOnly(context: BrowserContext) {
  const outbound: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:")
      return route.continue();
    if (LOOPBACK_HOSTS.has(url.hostname)) return route.continue();
    outbound.push(`${url.protocol}//${url.host}${url.pathname}`);
    return route.abort();
  });
  return outbound;
}
