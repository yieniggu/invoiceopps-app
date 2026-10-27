/**
 * Number of reverse-proxy hops Express may trust for `request.ip`
 * (AUTH_TRUST_PROXY_HOPS). Unset or blank keeps "trust proxy" off, so
 * X-Forwarded-For is ignored and the socket address is the client address.
 * Throws on anything that is not a non-negative integer so a typo can never
 * silently trust (or silently stop trusting) a proxy.
 */
export function trustProxyHopsFromEnv(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const hops = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(hops)) {
    throw new Error("AUTH_TRUST_PROXY_HOPS must be a non-negative integer");
  }
  return hops;
}
