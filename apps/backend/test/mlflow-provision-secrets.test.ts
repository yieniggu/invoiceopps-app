import {
  chmod,
  link,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadProvisionSecrets } from "../src/mlflow-provision-secrets.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  contents = { "123456785": "synthetic-random-long-value" },
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "invoiceops-mlflow07-")),
  );
  directories.push(directory);
  const file = join(directory, "credentials.json");
  await writeFile(file, JSON.stringify(contents), { mode: 0o600 });
  return { directory, file };
}

describe("MLFLOW07 explicit local secret-file boundary", () => {
  it("attempts descriptor closure exactly once even when buffer cleanup throws", async () => {
    const { file } = await fixture();
    const descriptor = await open(file, "r");
    const metadata = await descriptor.stat();
    await descriptor.close();
    const marker = "synthetic-private-plaintext-wipe-failure";
    const close = vi.fn(async () => undefined);
    let restoreFill: (() => void) | undefined;
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => metadata,
      close,
      read: async (buffer: Buffer) => {
        buffer.write(marker);
        const fill = vi.spyOn(buffer, "fill").mockImplementation(() => {
          throw new Error(marker);
        });
        restoreFill = () => fill.mockRestore();
        return { bytesRead: metadata.size, buffer };
      },
    } as unknown as Awaited<ReturnType<typeof open>>);
    try {
      const outcome = await loadProvisionSecrets(file, process.cwd(), [
        "123456785",
      ]).catch((error: unknown) => error);
      expect(outcome).toMatchObject({
        message: "CREDENTIALS",
        status: 503,
        code: "CREDENTIALS",
      });
      expect(String(outcome)).not.toContain(marker);
      expect(JSON.stringify(outcome)).not.toContain(marker);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      restoreFill?.();
    }
  });

  it.each([
    "success",
    "invalid-json",
    "short-read",
    "changed-file",
    "read-error",
    "stat-error",
    "close-error",
  ])(
    "wipes the allocated plaintext buffer and closes the descriptor on %s",
    async (scenario) => {
      const { file } = await fixture();
      const descriptor = await open(file, "r");
      const metadata = await descriptor.stat();
      await descriptor.close();
      let plaintext: Buffer | undefined;
      const close = vi.fn(async () => {
        if (scenario === "close-error")
          throw new Error("synthetic-private-close");
      });
      const stat = vi
        .fn()
        .mockResolvedValueOnce(metadata)
        .mockImplementation(async () => {
          if (scenario === "stat-error")
            throw new Error("synthetic-private-stat");
          return scenario === "changed-file"
            ? { ...metadata, mtimeMs: metadata.mtimeMs + 1 }
            : metadata;
        });
      vi.mocked(open).mockResolvedValueOnce({
        stat,
        close,
        read: async (buffer: Buffer) => {
          plaintext = buffer;
          buffer.write(
            scenario === "invalid-json"
              ? "synthetic-private-invalid-json"
              : '{"123456785":"synthetic-random-long-value"}',
          );
          if (scenario === "read-error")
            throw new Error("synthetic-private-read");
          return {
            bytesRead:
              scenario === "short-read" ? metadata.size - 1 : metadata.size,
            buffer,
          };
        },
      } as unknown as Awaited<ReturnType<typeof open>>);
      if (scenario === "success") {
        expect(
          await loadProvisionSecrets(file, process.cwd(), ["123456785"]),
        ).toEqual(new Map([["123456785", "synthetic-random-long-value"]]));
      } else {
        await expect(
          loadProvisionSecrets(file, process.cwd(), ["123456785"]),
        ).rejects.toMatchObject({ message: "CREDENTIALS", status: 503 });
      }
      expect(close).toHaveBeenCalledTimes(1);
      expect(plaintext).toBeDefined();
      expect(plaintext!.every((byte) => byte === 0)).toBe(true);
    },
  );

  it("reads synthetic owner-only credentials only for required new usernames", async () => {
    const { file } = await fixture();
    expect(
      await loadProvisionSecrets(file, process.cwd(), ["123456785"]),
    ).toEqual(new Map([["123456785", "synthetic-random-long-value"]]));
    expect(
      await loadProvisionSecrets("/nonexistent-not-read", process.cwd(), []),
    ).toEqual(new Map());
  });

  it("rejects permissive files, symlinks, in-repository paths and missing credentials", async () => {
    const { file, directory } = await fixture();
    await chmod(file, 0o644);
    await expect(
      loadProvisionSecrets(file, process.cwd(), ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
    await chmod(file, 0o600);
    const link = join(directory, "link.json");
    await symlink(file, link);
    await expect(
      loadProvisionSecrets(link, process.cwd(), ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
    await expect(
      loadProvisionSecrets(file, directory, ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
    await expect(
      loadProvisionSecrets(file, process.cwd(), ["999999999"]),
    ).rejects.toThrow("CREDENTIALS");
    await expect(
      loadProvisionSecrets("relative.json", process.cwd(), ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
  });

  it("rejects short or reused passwords and bounded oversized files", async () => {
    const { file } = await fixture({ "123456785": "short" });
    await expect(
      loadProvisionSecrets(file, process.cwd(), ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
    await writeFile(
      file,
      JSON.stringify({
        "123456785": "same-synthetic-long-value",
        "876543210": "same-synthetic-long-value",
      }),
    );
    await expect(
      loadProvisionSecrets(file, process.cwd(), ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
    await writeFile(file, "x".repeat(65537));
    await expect(
      loadProvisionSecrets(file, process.cwd(), ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
  });

  it("rejects directory and hardlinked sources, accepts read-only owner credentials", async () => {
    const { file, directory } = await fixture();
    await expect(
      loadProvisionSecrets(directory, process.cwd(), ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
    await chmod(file, 0o400);
    expect(
      (await loadProvisionSecrets(file, process.cwd(), ["123456785"])).size,
    ).toBe(1);
    await link(file, join(directory, "hardlink.json"));
    await expect(
      loadProvisionSecrets(file, process.cwd(), ["123456785"]),
    ).rejects.toThrow("CREDENTIALS");
  });
});
