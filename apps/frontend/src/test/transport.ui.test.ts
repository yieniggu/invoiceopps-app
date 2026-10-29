import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, mockTransport, pagedList } from "./transport";

afterEach(() => {
  vi.restoreAllMocks();
});

const UUID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const people = Array.from({ length: 30 }, (_unused, index) => ({
  id: UUID(index + 1),
}));

async function ask(search: string) {
  const transport = mockTransport({
    "GET /api/v1/things": pagedList("things", people, ({ id }) => id),
  });
  const response = await fetch(`/api/v1/things${search}`);
  return { response, body: await response.json(), transport };
}

describe("pagedList mirrors the server's query validation", () => {
  it("serves valid queries like before", async () => {
    const { response, body } = await ask(
      `?page=2&pageSize=10&userIds=${UUID(1)},${UUID(2)}`,
    );
    expect(response.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.things).toEqual([]);
    const first = await ask(`?userIds=${UUID(1)},${UUID(2)}`);
    expect(first.body.things.map(({ id }: { id: string }) => id)).toEqual([
      UUID(1),
      UUID(2),
    ]);
  });

  it.each([
    ["a non-UUID id", "?userIds=user-110"],
    ["a duplicate id", `?userIds=${UUID(1)},${UUID(1)}`],
    ["an empty userIds", "?userIds="],
    ["an empty segment", `?userIds=${UUID(1)},`],
    [
      "more than 200 ids",
      `?userIds=${Array.from({ length: 201 }, (_u, i) => UUID(i + 1)).join(",")}`,
    ],
    ["pageSize above 100", "?pageSize=101"],
    ["pageSize 0", "?pageSize=0"],
    ["page above 10000", "?page=10001"],
    ["page 0", "?page=0"],
    ["a decimal page", "?page=1.5"],
    ["a text page", "?page=abc"],
  ])("answers 400 VALIDATION_ERROR for %s", async (_label, search) => {
    const { response, body } = await ask(search);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(typeof body.error.message).toBe("string");
  });
});

describe("mockTransport mirrors the server for path ids that are not UUIDs", () => {
  it.each([
    "/api/v1/organizations/org-1",
    "/api/v1/organizations/org-1/users",
    `/api/v1/organizations/${UUID(1)}/groups/group-a/memberships`,
    `/api/v1/organizations/${UUID(1)}/memberships/user-1`,
    "/api/v1/admin/users/user-1",
    "/api/v1/users/user-1",
  ])(
    "answers 404 NOT_FOUND for %s without reaching the handler",
    async (path) => {
      const handler = vi.fn(() => jsonResponse({}));
      const transport = mockTransport({ [`GET ${path}`]: handler });
      const response = await fetch(path);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
      expect(handler).not.toHaveBeenCalled();
      expect(transport.unexpected).toEqual([]);
    },
  );

  it("keeps serving UUID ids and the fixed sub-paths", async () => {
    const paths = [
      `/api/v1/organizations/${UUID(1)}`,
      `/api/v1/organizations/${UUID(1)}/memberships/bulk`,
      `/api/v1/organizations/${UUID(1)}/groups/${UUID(2)}/memberships/permissions`,
      "/api/v1/admin/users",
    ];
    mockTransport(
      Object.fromEntries(
        paths.map((p) => [`GET ${p}`, () => jsonResponse({ ok: true })]),
      ),
    );
    for (const path of paths)
      expect((await fetch(path)).status, path).toBe(200);
  });
});
