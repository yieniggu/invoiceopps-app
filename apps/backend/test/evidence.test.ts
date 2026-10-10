import { describe, expect, it } from "vitest";

import { canonicalizeEvidenceValue } from "../src/evidence.js";

describe("APP-10 pure canonicalization", () => {
  it("emits exact compact UTF-8 bytes with sorted nested keys and preserves supported values", () => {
    const result = canonicalizeEvidenceValue({
      z: null,
      nested: { z: false, a: [true, 0, "niño", -17] },
      a: "área",
    });

    expect(result).toEqual(
      Buffer.from(
        '{"a":"área","nested":{"a":[true,0,"niño",-17],"z":false},"z":null}',
        "utf8",
      ),
    );
  });

  it("produces the same bytes regardless of object insertion order", () => {
    const first = canonicalizeEvidenceValue({
      z: [{ b: 2, a: 1 }],
      a: { y: null, x: "sí" },
    });
    const reversed = canonicalizeEvidenceValue({
      a: { x: "sí", y: null },
      z: [{ a: 1, b: 2 }],
    });

    expect(first).toEqual(reversed);
    expect(first).toEqual(
      Buffer.from('{"a":{"x":"sí","y":null},"z":[{"a":1,"b":2}]}', "utf8"),
    );
  });

  it("sorts numeric-looking keys lexically rather than by JavaScript enumeration order", () => {
    const result = canonicalizeEvidenceValue({ "2": "second", "10": "tenth" });

    expect(result).toEqual(Buffer.from('{"10":"tenth","2":"second"}', "utf8"));
  });

  it("rejects fractional numbers even when nested", () => {
    expect(() =>
      canonicalizeEvidenceValue({ nested: [1, { value: 0.8 }] }),
    ).toThrow();
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite number %s",
    (value) => {
      expect(() => canonicalizeEvidenceValue({ value })).toThrow();
    },
  );

  it("rejects unsupported values instead of silently dropping them", () => {
    expect(() => canonicalizeEvidenceValue({ omitted: undefined })).toThrow();
    expect(() => canonicalizeEvidenceValue([undefined])).toThrow();
    expect(() => canonicalizeEvidenceValue({ time: new Date() })).toThrow();
  });

  it("rejects non-enumerable array indices instead of serializing hidden values", () => {
    const values = ["hidden"];
    Object.defineProperty(values, "0", { enumerable: false });

    expect(() => canonicalizeEvidenceValue(values)).toThrow(
      "Unsupported canonical evidence array property",
    );
  });

  it("accepts safe integer boundaries and rejects values beyond them", () => {
    expect(
      canonicalizeEvidenceValue([
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
      ]),
    ).toEqual(Buffer.from("[9007199254740991,-9007199254740991]", "utf8"));
    expect(() =>
      canonicalizeEvidenceValue(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow("Canonical evidence requires safe integers");
    expect(() =>
      canonicalizeEvidenceValue(Number.MIN_SAFE_INTEGER - 1),
    ).toThrow("Canonical evidence requires safe integers");
  });

  it("rejects cyclic objects and arrays", () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push(array);

    expect(() => canonicalizeEvidenceValue(object)).toThrow();
    expect(() => canonicalizeEvidenceValue(array)).toThrow();
  });
});
