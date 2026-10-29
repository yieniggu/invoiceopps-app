import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Guard against a documentation file being silently emptied (LOCAL_RUN.md was
// once truncated to 0 bytes by a scripted edit). Keep the checks coarse: they
// assert the files exist, are substantial and keep their key sections, not
// their wording.
const root = resolve(import.meta.dirname, "../../../..");
const read = (name: string) => readFileSync(resolve(root, name), "utf8");

const docs = [
  {
    file: "README.md",
    minLines: 300,
    headings: ["# InvoiceOps App", "## Requisitos", "## Configuración local"],
  },
  {
    file: "LOCAL_RUN.md",
    minLines: 300,
    headings: [
      "# Levantar InvoiceOps App en local",
      "## Requisitos",
      "## 1. Configuración privada",
      "## 3. PostgreSQL y base de desarrollo",
      "## Tests",
      "## Problemas frecuentes",
    ],
  },
] as const;

describe.each(docs)(
  "documentation guard: $file",
  ({ file, minLines, headings }) => {
    const text = read(file);

    it("is not empty and keeps its size", () => {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.split("\n").length).toBeGreaterThanOrEqual(minLines);
    });

    it.each(headings)("keeps the heading %s", (heading) => {
      expect(text.split("\n")).toContain(heading);
    });
  },
);
