// Same host and query rules as scripts/recovery-db-guards.mjs. That module
// lives outside tsconfig's rootDir (src), so it cannot be imported from here;
// test/recovery/database-url-parity.unit.test.ts runs one table of cases
// against both guards so they cannot drift. Unlike the script, this guard does
// not restrict the database name.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const ALLOWED_QUERY_KEYS = ["schema", "sslmode", "connect_timeout"];

// pg-connection-string lets `?host=` override the URL hostname, so the query
// string is validated with the host: only an allowlist of exact lowercase
// keys, each at most once, and `host` only for the empty-hostname socket form.
function assertSafeQuery(url: URL) {
  const allowed = new Set(ALLOWED_QUERY_KEYS);
  if (url.hostname === "") allowed.add("host");
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) {
      throw new Error("DATABASE_URL repeats a connection parameter");
    }
    seen.add(key);
    if (!allowed.has(key)) {
      throw new Error(
        "DATABASE_URL contains a connection parameter that is not allowed",
      );
    }
  }
}

/** Throws unless the URL targets a loopback host or a unix socket. */
export function assertLocalDatabaseUrl(value: string | undefined) {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use the postgresql protocol");
  }
  if (url.hostname === "") {
    const socket = url.searchParams.get("host");
    if (!socket || !socket.startsWith("/") || socket.includes(",")) {
      throw new Error("DATABASE_URL must point to loopback or a unix socket");
    }
  } else if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(
      "DATABASE_URL is not local: the bootstrap only runs against loopback",
    );
  }
  assertSafeQuery(url);
}
