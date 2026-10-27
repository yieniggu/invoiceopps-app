import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Backend code, comments, API messages, CLI output and logs are English; only
// the React UI is Spanish. This guard scans src (not generated code) for
// accented letters and common Spanish words.
const SPANISH_WORDS =
  /\b(caracteres|contrase[nñ]a|inv[aá]lid[oa]s?|usuarios?|organizaci[oó]n|grupos?|facturas?|seguimiento|debe|nunca|solo|sesi[oó]n)\b/i;
const ACCENTS = /[áéíóúñüÁÉÍÓÚÑ¿¡]/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : sourceFiles(path);
    }
    return /\.(ts|mts|mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

describe("backend source is English", () => {
  const files = [
    ...sourceFiles(resolve("src")),
    ...sourceFiles(resolve("scripts")),
  ];

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("contains no accented letters or common Spanish words", () => {
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          ACCENTS.test(line) || SPANISH_WORDS.test(line)
            ? [`${file}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
