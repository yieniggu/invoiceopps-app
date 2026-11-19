import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";

import {
  assertPortFree,
  isAcceptingConnections,
  listPortHolders,
  portInUseMessage,
} from "../../scripts/port-probe.mjs";

const listen = (host: string) =>
  new Promise<{ server: Server; port: number }>((resolveListen) => {
    const server = createServer((socket) => socket.end());
    server.listen(0, host, () =>
      resolveListen({
        server,
        port: (server.address() as { port: number }).port,
      }),
    );
  });
const close = (server: Server) =>
  new Promise<void>((done) => server.close(() => done()));

describe("assertPortFree (best-effort)", () => {
  it("accepts a port nothing listens on", async () => {
    const { server, port } = await listen("127.0.0.1");
    await close(server);
    await expect(assertPortFree(port)).resolves.toBeUndefined();
    expect(await isAcceptingConnections(port)).toBe(false);
  });

  it("refuses a port with a listener on loopback", async () => {
    const { server, port } = await listen("127.0.0.1");
    try {
      expect(await isAcceptingConnections(port)).toBe(true);
      await expect(assertPortFree(port)).rejects.toThrow(/already in use/);
    } finally {
      await close(server);
    }
  });

  it("refuses a port held on the wildcard address, which a bind probe can miss", async () => {
    const { server, port } = await listen("0.0.0.0");
    try {
      // The connect probe sees it whatever the platform's bind semantics.
      expect(await isAcceptingConnections(port)).toBe(true);
      await expect(assertPortFree(port)).rejects.toThrow(
        /already in use \(connect\)/,
      );
    } finally {
      await close(server);
    }
  });
});

describe("port holders (CR-427, best effort)", () => {
  it("parses the PIDs lsof prints, deduplicated", async () => {
    const run = async (command: string, args: string[]) => {
      expect(command).toBe("lsof");
      expect(args).toEqual(["-nP", "-iTCP:4391", "-sTCP:LISTEN", "-t"]);
      return "123\n456\n123\n";
    };
    expect(await listPortHolders(4391, run)).toEqual(["123", "456"]);
  });

  it("is empty when lsof is missing or fails", async () => {
    expect(
      await listPortHolders(1, async () => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
    expect(await listPortHolders(1, () => "")).toEqual([]);
  });

  it("names the holders and the cleanup command in the refusal", async () => {
    expect(portInUseMessage(4391, "connect", [])).not.toMatch(/kill/);
    expect(portInUseMessage(4391, "connect", ["12", "34"])).toMatch(
      /PID 12, 34.*kill 12 34/,
    );
    const { server, port } = await listen("127.0.0.1");
    try {
      await expect(
        assertPortFree(port, { listHolders: async () => ["999"] }),
      ).rejects.toThrow(/already in use.*kill 999/);
    } finally {
      await close(server);
    }
  });
});
