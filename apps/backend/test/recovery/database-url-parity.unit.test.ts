import { describe, expect, it } from "vitest";

import { assertLocalDatabaseUrl } from "../../src/local-database-url.js";
import { assertRecoveryTarget } from "../../scripts/recovery-db-guards.mjs";

// One table of cases runs against both guards: the TypeScript guard used by
// `pnpm recovery:bootstrap` and the script guard used by the reset and test
// runner. Only the accept/reject decision is compared, never the message.
const DB = "invoiceops";
const accepted: Array<[string, string]> = [
  ["loopback name", `postgresql://u:p@localhost:5545/${DB}`],
  ["loopback ipv4", `postgresql://u:p@127.0.0.1:5545/${DB}?schema=public`],
  ["loopback ipv6", `postgres://u:p@[::1]:5432/${DB}`],
  [
    "allowed keys",
    `postgresql://u:p@localhost/${DB}?sslmode=disable&connect_timeout=5&schema=public`,
  ],
  ["unix socket", `postgresql:///${DB}?host=/var/run/postgresql`],
  [
    "unix socket with allowed key",
    `postgresql:///${DB}?host=/tmp&sslmode=disable`,
  ],
];
const rejected: Array<[string, string]> = [
  [
    "host override on a loopback hostname",
    `postgresql://u:p@localhost/${DB}?host=evil.example`,
  ],
  [
    "uppercase HOST override",
    `postgresql://u:p@localhost/${DB}?HOST=evil.example`,
  ],
  [
    "mixed-case Host override",
    `postgresql://u:p@localhost/${DB}?Host=evil.example`,
  ],
  [
    "host override on a socket form",
    `postgresql:///${DB}?host=/tmp&HOST=evil.example`,
  ],
  ["duplicate host", `postgresql:///${DB}?host=/tmp&host=/var/run`],
  [
    "duplicate allowed key",
    `postgresql://u:p@localhost/${DB}?schema=a&schema=b`,
  ],
  [
    "case variant of an allowed key",
    `postgresql://u:p@localhost/${DB}?SSLMODE=disable`,
  ],
  ["unknown key", `postgresql://u:p@localhost/${DB}?hostaddr=203.0.113.9`],
  ["unknown key on a socket form", `postgresql:///${DB}?host=/tmp&service=x`],
  ["remote hostname", `postgresql://u:p@db.example.com/${DB}`],
  ["remote socket host", `postgresql:///${DB}?host=remote.example`],
  ["multi-host socket value", `postgresql:///${DB}?host=/tmp,evil.example`],
  ["wrong protocol", `mysql://u:p@localhost/${DB}`],
];

const guards: Array<[string, (url: string) => void]> = [
  ["TypeScript guard", (url) => assertLocalDatabaseUrl(url)],
  [
    "script guard",
    (url) =>
      assertRecoveryTarget(url, { confirmReset: DB, allowedNames: [DB] }),
  ],
];

describe.each(guards)("database URL parity: %s", (_name, guard) => {
  it.each(accepted)("accepts %s", (_label, url) => {
    expect(() => guard(url)).not.toThrow();
  });

  it.each(rejected)("rejects %s", (_label, url) => {
    expect(() => guard(url)).toThrow();
  });
});
