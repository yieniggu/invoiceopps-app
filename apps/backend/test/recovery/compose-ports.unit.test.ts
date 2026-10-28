import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// CR-259: every port the compose files publish is bound to loopback. The test
// database has a known password and the suites wipe it; the backend trusts one
// proxy hop; neither may be reachable from the network.

const publishedPorts = (file: string) => {
  const lines = readFileSync(
    new URL(`../../../../${file}`, import.meta.url),
    "utf8",
  ).split("\n");
  const ports: string[] = [];
  let inPorts = false;
  for (const line of lines) {
    const entry = /^\s+-\s+"?([^"\s#]+)"?\s*$/.exec(line);
    if (/^\s+ports:/.test(line)) inPorts = true;
    else if (inPorts && entry) ports.push(entry[1]);
    else if (inPorts && !/^\s*#/.test(line)) inPorts = false;
  }
  return ports;
};

describe.each([
  "docker-compose.yml",
  "docker-compose.smoke.yml",
  "compose.invoiceops-local.yml",
])("%s", (file) => {
  it("publishes only loopback ports", () => {
    const ports = publishedPorts(file);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port, port).toMatch(/^127\.0\.0\.1:/);
  });
});
