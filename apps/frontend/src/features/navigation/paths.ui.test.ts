import { describe, expect, it } from "vitest";

import { MAX_URL_USER_IDS, parseUserIds } from "./paths";

const query = (value?: string) =>
  new URLSearchParams(value === undefined ? "" : `userIds=${value}`);
const ids = (count: number) =>
  Array.from({ length: count }, (_unused, index) => `user-${index}`);

describe("parseUserIds (CR-233)", () => {
  it("reads nothing from a missing or empty parameter", () => {
    expect(parseUserIds(query())).toEqual([]);
    expect(parseUserIds(query(""))).toEqual([]);
    expect(parseUserIds(query(",,,"))).toEqual([]);
  });

  it("reads one id", () => {
    expect(parseUserIds(query("user-1"))).toEqual(["user-1"]);
  });

  it("keeps exactly 200 ids, in order", () => {
    const all = ids(200);
    expect(parseUserIds(query(all.join(",")))).toEqual(all);
  });

  it("keeps 201 ids so the 200-person guard still trips", () => {
    expect(MAX_URL_USER_IDS).toBe(201);
    const all = ids(201);
    expect(parseUserIds(query(all.join(",")))).toEqual(all);
  });

  it("drops everything beyond 201 ids instead of processing an unbounded list", () => {
    const parsed = parseUserIds(query(ids(5000).join(",")));
    expect(parsed).toHaveLength(201);
    expect(parsed[200]).toBe("user-200");
  });

  it("ignores empty segments and repeated ids, keeping first-seen order", () => {
    expect(parseUserIds(query("b,,a,b,a,c,"))).toEqual(["b", "a", "c"]);
  });

  it("counts only distinct ids toward the cap", () => {
    const repeated = [
      ...ids(150),
      ...ids(150),
      ...ids(100).map((id) => `x-${id}`),
    ];
    const parsed = parseUserIds(query(repeated.join(",")));
    expect(parsed).toHaveLength(201);
    expect(new Set(parsed).size).toBe(201);
  });

  it("keeps odd values verbatim: validity is the server's call", () => {
    expect(parseUserIds(query("not-a-uuid,%20spaced,ñandú"))).toEqual([
      "not-a-uuid",
      " spaced",
      "ñandú",
    ]);
  });

  it("only reads the userIds parameter", () => {
    expect(
      parseUserIds(new URLSearchParams("other=a,b&userIds=c&userIds=d")),
    ).toEqual(["c"]);
  });
});
