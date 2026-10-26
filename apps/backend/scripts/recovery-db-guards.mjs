// Pure guards for the local reset targets: the single dev database and the
// dedicated recovery test database. Nothing in this module opens a connection
// or reads the environment implicitly.

export const devDatabaseName = "invoiceops";
export const testDatabaseName = "invoiceops_recovery_test";
export const recoveryDatabaseNames = [devDatabaseName, testDatabaseName];

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const confirmPrefix = "--confirm-reset=";
const envPattern = /^[A-Z_][A-Z0-9_]*$/;

function reject(message) {
  // Messages never include the raw URL, user or password.
  return new Error(`Recovery reset refused: ${message}`);
}

// decodeURIComponent throws URIError on malformed escapes; callers choose
// the fallback so no raw value ever reaches an error message.
export function safeDecode(value, fallback = value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return fallback;
  }
}

function parseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw reject("database URL is missing or empty");
  }
  try {
    return new URL(value);
  } catch {
    throw reject("database URL is not a valid URL");
  }
}

function resolveHost(url) {
  const params = url.searchParams;
  const hostParam = params.get("host");
  if (
    [...params.keys()].some(
      (key) => key !== "host" && key.toLowerCase() === "host",
    )
  ) {
    throw reject('query parameter "host" must be lowercase');
  }
  if (url.hostname === "") {
    // Unix socket form: postgresql:///db?host=/var/run/postgresql
    if (!hostParam || !hostParam.startsWith("/") || hostParam.includes(",")) {
      throw reject("host must be loopback or an absolute unix socket path");
    }
    if (params.getAll("host").length > 1) {
      throw reject('query parameter "host" must appear once');
    }
  } else if (!loopbackHosts.has(url.hostname.toLowerCase())) {
    throw reject("host must be localhost, 127.0.0.1, ::1 or a unix socket");
  }
  const allowed = new Set(["schema", "sslmode", "connect_timeout"]);
  if (url.hostname === "") allowed.add("host");
  for (const key of params.keys()) {
    if (!allowed.has(key.toLowerCase())) {
      throw reject(`query parameter "${key.slice(0, 40)}" is not allowed`);
    }
  }
}

export function sanitizeTarget(value) {
  const url = parseUrl(value);
  const name = safeDecode(url.pathname.replace(/^\//, ""));
  const socket = url.hostname === "" ? url.searchParams.get("host") : null;
  const host = socket ?? `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  return `${host}/${name}`;
}

export function assertRecoveryTarget(
  value,
  { confirmReset, allowedNames = recoveryDatabaseNames } = {},
) {
  const url = parseUrl(value);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw reject("protocol must be postgres or postgresql");
  }
  resolveHost(url);
  const databaseName = safeDecode(url.pathname.replace(/^\//, ""), null);
  if (databaseName === null) {
    throw reject("database name is not valid");
  }
  if (
    !recoveryDatabaseNames.includes(databaseName) ||
    !allowedNames.includes(databaseName)
  ) {
    throw reject(`database name must be exactly ${allowedNames.join(" or ")}`);
  }
  if (confirmReset !== databaseName) {
    throw reject(
      `explicit confirmation required: pass ${confirmPrefix}${databaseName}`,
    );
  }
  const maintenance = new URL(url.href);
  maintenance.pathname = "/postgres";
  return {
    databaseName,
    url: url.href,
    maintenanceUrl: maintenance.href,
    sanitized: sanitizeTarget(value),
  };
}

export function parseResetArguments(argv, env) {
  let envName = "DATABASE_URL";
  let confirmReset;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument.startsWith(confirmPrefix)) {
      confirmReset = argument.slice(confirmPrefix.length);
    } else if (argument === "--database-url-env") {
      envName = argv[(index += 1)] ?? "";
    } else if (argument.startsWith("--database-url-env=")) {
      envName = argument.slice("--database-url-env=".length);
    } else {
      throw reject(`unknown argument at position ${index + 1}`);
    }
  }
  if (!envPattern.test(envName)) {
    throw reject("--database-url-env must be an environment variable name");
  }
  const url = env[envName];
  if (!url) {
    throw reject(`${envName} is not set`);
  }
  return { url, confirmReset, envName };
}
