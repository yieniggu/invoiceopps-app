// Ports of the browser E2E suite. The suite starts (or reuses) a backend and a
// Vite server and recreates the database behind them, so it must never share a
// port with the development stack: reusing a development server would point
// the suite at the development data. Pure: nothing here opens a socket.

/** Defaults of the development stack and of the Docker flows. */
export const defaultDevelopmentPorts = [4380, 5380, 3000, 5173, 5300, 5174];

/** Variables that configure a development port in `.env` or the shell. */
const developmentPortVariables = [
  "PORT",
  "BACKEND_PORT",
  "FRONTEND_PORT",
  "LOCAL_BACKEND_PORT",
  "LOCAL_FRONTEND_PORT",
];

const asPort = (raw) => {
  const text = String(raw ?? "").trim();
  return /^\d{1,5}$/.test(text) ? Number(text) : undefined;
};

/** Every port the development configuration uses, defaults included. */
export function developmentPorts(env = process.env) {
  const ports = new Set(defaultDevelopmentPorts);
  for (const name of developmentPortVariables) {
    const port = asPort(env[name]);
    if (port !== undefined) ports.add(port);
  }
  return ports;
}

/**
 * The port in `env[name]` (or `fallback`), refused when it is not a plain
 * unprivileged port or when it is one the development configuration uses.
 */
export function e2ePort(name, fallback, env = process.env) {
  const raw = env[name];
  const value =
    raw === undefined || String(raw).trim() === "" ? fallback : asPort(raw);
  if (value === undefined || value < 1024 || value > 65535) {
    throw new Error(`${name} must be a port between 1024 and 65535`);
  }
  if (developmentPorts(env).has(value)) {
    throw new Error(
      `${name}=${value} is a development port: the E2E suite recreates its database and refuses to share a port with the development stack`,
    );
  }
  return value;
}
