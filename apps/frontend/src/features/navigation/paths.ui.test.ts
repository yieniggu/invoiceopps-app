import { describe, expect, it } from "vitest";

import { MAX_URL_USER_IDS, parseUserIds, paths } from "./paths";

const query = (value?: string) =>
  new URLSearchParams(value === undefined ? "" : `userIds=${value}`);
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (count: number) =>
  Array.from({ length: count }, (_unused, index) => uuid(index));

describe("parseUserIds (CR-233)", () => {
  it("reads nothing from a missing or empty parameter", () => {
    expect(parseUserIds(query())).toEqual([]);
    expect(parseUserIds(query(""))).toEqual([]);
    expect(parseUserIds(query(",,,"))).toEqual([]);
  });

  it("reads one id", () => {
    expect(parseUserIds(query(uuid(1)))).toEqual([uuid(1)]);
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
    expect(parsed[200]).toBe(uuid(200));
  });

  it("ignores empty segments and repeated ids, keeping first-seen order", () => {
    const [a, b, c] = [uuid(1), uuid(2), uuid(3)];
    expect(parseUserIds(query(`${b},,${a},${b},${a},${c},`))).toEqual([
      b,
      a,
      c,
    ]);
  });

  it("counts only distinct ids toward the cap", () => {
    const repeated = [
      ...ids(150),
      ...ids(150),
      ...Array.from({ length: 100 }, (_unused, index) => uuid(1000 + index)),
    ];
    const parsed = parseUserIds(query(repeated.join(",")));
    expect(parsed).toHaveLength(201);
    expect(new Set(parsed).size).toBe(201);
  });

  it("drops values that are not UUIDs, so a crafted URL never reaches the API", () => {
    expect(
      parseUserIds(
        query(
          `not-a-uuid,%20spaced,ñandú,user-1,${uuid(7)},../../x,${uuid(8)}`,
        ),
      ),
    ).toEqual([uuid(7), uuid(8)]);
    expect(parseUserIds(query("user-1,user-2"))).toEqual([]);
  });

  it("does not let invalid ids use up the cap", () => {
    const junk = Array.from({ length: 500 }, (_unused, index) => `x-${index}`);
    expect(parseUserIds(query([...junk, ...ids(3)].join(",")))).toEqual(ids(3));
  });

  it("only reads the userIds parameter", () => {
    expect(
      parseUserIds(
        new URLSearchParams(
          `other=${uuid(1)},${uuid(2)}&userIds=${uuid(3)}&userIds=${uuid(4)}`,
        ),
      ),
    ).toEqual([uuid(3)]);
  });
});

describe("list and profile URLs of the admin surface", () => {
  it("writes only non-default directory params, so /admin stays clean", () => {
    expect(paths.adminUsers()).toBe("/admin");
    expect(paths.adminUsers({ search: "", status: "all", page: 1 })).toBe(
      "/admin",
    );
    expect(
      paths.adminUsers({ search: "ana pérez", status: "disabled", page: 3 }),
    ).toBe("/admin?search=ana+p%C3%A9rez&status=disabled&page=3");
    expect(paths.organizationsPage({ search: "norte", page: 2 })).toBe(
      "/organizations?search=norte&page=2",
    );
  });

  it("encodes the ids of profile and edit URLs", () => {
    expect(paths.adminUser("a/b")).toBe("/admin/users/a%2Fb");
    expect(paths.user("u 1")).toBe("/users/u%201");
    expect(paths.editOrganization("00000000-0000-4000-9000-000000000001")).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/edit",
    );
  });
});
