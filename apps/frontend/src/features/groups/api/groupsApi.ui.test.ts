import { afterEach, describe, expect, it, vi } from "vitest";

import { listMembershipsByIds } from "../../orgs/api/orgsApi";
import { jsonResponse, mockTransport } from "../../../test/transport";
import { listGroupMembersByIds } from "./groupsApi";

afterEach(() => {
  vi.restoreAllMocks();
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (count: number) =>
  Array.from({ length: count }, (_unused, index) => uuid(index + 1));

/** A route that answers after a tick and records how many overlapped. */
function slowRoute(key: "memberships") {
  const state = { inFlight: 0, peak: 0, calls: 0, sent: [] as string[][] };
  const handler = async ({ search }: { search: string }) => {
    state.calls += 1;
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    state.sent.push(
      (new URLSearchParams(search).get("userIds") ?? "").split(","),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.inFlight -= 1;
    return jsonResponse({ [key]: [], page: 1, pageSize: 100, total: 0 });
  };
  return { state, handler };
}

describe("lookups by ids stay inside a small request budget (CR-298)", () => {
  it("asks the group's memberships for 1000 ids in chunks of 100, at most 4 at a time", async () => {
    const { state, handler } = slowRoute("memberships");
    mockTransport({
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000001/memberships":
        handler,
    });
    await listGroupMembersByIds(
      "00000000-0000-4000-9000-000000000001",
      "00000000-0000-4000-a000-000000000001",
      ids(1000),
    );
    expect(state.calls).toBe(10);
    expect(state.peak).toBeLessThanOrEqual(4);
    expect(state.peak).toBeGreaterThan(1);
    expect(state.sent.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(new Set(state.sent.flat()).size).toBe(1000);
  });

  it("asks the organization's memberships for 1000 ids in chunks of 100, at most 4 at a time", async () => {
    const { state, handler } = slowRoute("memberships");
    mockTransport({
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        handler,
    });
    await listMembershipsByIds(
      "00000000-0000-4000-9000-000000000001",
      ids(1000),
    );
    expect(state.calls).toBe(10);
    expect(state.peak).toBeLessThanOrEqual(4);
    expect(state.peak).toBeGreaterThan(1);
    expect(new Set(state.sent.flat()).size).toBe(1000);
  });

  it("sends nothing for no ids", async () => {
    const transport = mockTransport({});
    expect(
      await listGroupMembersByIds(
        "00000000-0000-4000-9000-000000000001",
        "00000000-0000-4000-a000-000000000001",
        [],
      ),
    ).toEqual([]);
    expect(
      await listMembershipsByIds("00000000-0000-4000-9000-000000000001", []),
    ).toEqual([]);
    expect(transport.requests).toEqual([]);
  });
});
