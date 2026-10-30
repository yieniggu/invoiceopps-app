/**
 * Browser-facing origin of the deployment (PUBLIC_ORIGIN), e.g.
 * `https://invoiceops.aglai.dev`. When set, cookie-bearing writes must carry
 * exactly this `Origin`; Host and X-Forwarded-Proto are ignored, so a proxy
 * chain that terminates TLS upstream cannot break (or spoof) the check.
 * Unset or blank keeps the Host-derived check. Throws on anything that is not
 * an absolute http(s) origin so a typo can never silently weaken the guard.
 */
export function publicOriginFromEnv(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const message =
    "PUBLIC_ORIGIN must be an absolute http(s) origin without path, e.g. https://example.com";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(message);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== trimmed
  ) {
    throw new Error(message);
  }
  return trimmed;
}
