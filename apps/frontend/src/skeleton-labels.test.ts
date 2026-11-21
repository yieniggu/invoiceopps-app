// @vitest-environment node
import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CR-587: every skeleton names what loads. The types already require it; this
// guards the source against a cast or a spread that would hide a missing label.
const sources = globSync("**/*.{ts,tsx}", { cwd: import.meta.dirname })
  .filter((file) => !/\.test\.tsx?$/.test(file) && !file.startsWith("test/"))
  .map((file) => ({
    file,
    code: readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
  }));

describe("skeleton announcements", () => {
  it("every <Skeleton> usage passes a label", () => {
    const missing = sources.flatMap(({ file, code }) =>
      [...code.matchAll(/<Skeleton\b([^>]*)\/>/g)]
        .filter((match) => !/\blabel=/.test(match[1] ?? ""))
        .map(() => file),
    );
    expect(missing).toEqual([]);
  });

  it("every QueryFeedback with a skeleton passes a loading label", () => {
    const missing = sources.flatMap(({ file, code }) =>
      [...code.matchAll(/<QueryFeedback\b[\s\S]*?\/>/g)]
        .filter(
          (match) =>
            /\bskeleton=/.test(match[0]) && !/\bloadingLabel=/.test(match[0]),
        )
        .map(() => file),
    );
    expect(missing).toEqual([]);
  });

  it("every skeleton message bundle carries a loading label", () => {
    const missing = sources.flatMap(({ file, code }) =>
      [...code.matchAll(/\bskeleton: \d+,(?!\s*loadingLabel:)/g)].map(
        () => file,
      ),
    );
    expect(missing).toEqual([]);
  });
});
