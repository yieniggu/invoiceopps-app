// @vitest-environment node
import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CR-560/561/579: loading and pending states are never text. Reads show a
// skeleton (`Skeleton`, `QueryFeedback skeleton`), mutations show a spinner in
// the button (`PendingLabel`, `PendingButton`) and a hidden live region
// (`LiveStatus`). A gerund followed by an ellipsis in the source is a text
// state, whether it is a string or JSX text (it may span lines).
const TEXT_STATE =
  /(["'`>])\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:ando|iendo)\b[^"'`<]*?(\.\.\.|…)/;

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no text loading states in the app", () => {
  const files = globSync("**/*.{ts,tsx}", {
    cwd: import.meta.dirname,
  }).filter((file) => !/\.test\.tsx?$/.test(file) && !file.startsWith("test/"));

  it("finds the source", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no gerund-with-ellipsis text in any component", () => {
    const offenders = files.filter((file) =>
      TEXT_STATE.test(
        withoutComments(
          readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
        ),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("catches the shapes it is meant to catch", () => {
    for (const sample of [
      '<p role="status">Cargando grupos...</p>',
      'const label = pending ? "Guardando…" : "Guardar";',
      "<p>\n  Cargando grupos...\n</p>",
      // Any Spanish gerund counts, not a fixed list of verbs (CR-561, CR-579).
      '<p role="status">Validando tu espacio de trabajo...</p>',
      'const hint = busy ? "Buscando organizaciones..." : "";',
      "<span>Descargando…</span>",
      "<p>Esperando respuesta del servidor...</p>",
    ])
      expect(TEXT_STATE.test(sample), sample).toBe(true);
    for (const sample of [
      "<PendingLabel pending>Guardar</PendingLabel>",
      'announce={{ pending: "Guardando perfil" }}',
      '<Skeleton rows={2} label="Validando tu espacio de trabajo" />',
      "const rest = [...items, ...more]; // no gerund before the spread",
      "<p>Mostrando 3 de 10 organizaciones.</p>",
    ])
      expect(TEXT_STATE.test(sample), sample).toBe(false);
  });
});
