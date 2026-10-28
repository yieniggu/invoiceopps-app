import request from "../support/request.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import type { GroupService } from "../../src/features/groups/services.js";
import type { OrganizationService } from "../../src/features/orgs/services.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "33333333-3333-4333-8333-333333333333";
const USER = "22222222-2222-4222-8222-222222222222";
const ACTOR = "user-1";

const profile = {
  id: ACTOR,
  name: "Ada Secretname",
  rut: "123456785",
  email: null,
  username: null,
  mustChangePassword: false,
  isPlatformAdministrator: false,
  memberships: [],
};

const auth: AuthService = {
  async login() {
    return {
      sessionToken: "opaque-session-token",
      user: { id: ACTOR, name: "Ada Secretname", rut: "123456785" },
    };
  },
  async logout() {},
  async getProfile() {
    return profile;
  },
  async updateProfile() {
    return profile;
  },
  async changePassword() {
    return { sessionToken: "rotated-session-token" };
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  return () =>
    info.mock.calls.map(([line]) => JSON.parse(String(line)) as object);
}

const permissions = {
  readInvoices: true,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

function appWith(overrides: {
  groups?: Partial<GroupService>;
  organizations?: Partial<OrganizationService>;
}) {
  return createApp({ isReady: async () => true }, auth, {
    groupAdministration: (overrides.groups ?? {}) as GroupService,
    organizations: (overrides.organizations ?? {}) as OrganizationService,
  });
}

const send = (app: ReturnType<typeof appWith>) => {
  const agent = request(app);
  return {
    put: (path: string) =>
      agent.put(`/api/v1${path}`).set(SAME_ORIGIN).set("Cookie", COOKIE),
    patch: (path: string) =>
      agent.patch(`/api/v1${path}`).set(SAME_ORIGIN).set("Cookie", COOKIE),
    post: (path: string) =>
      agent.post(`/api/v1${path}`).set(SAME_ORIGIN).set("Cookie", COOKIE),
    delete: (path: string) =>
      agent.delete(`/api/v1${path}`).set(SAME_ORIGIN).set("Cookie", COOKIE),
  };
};

describe("CR-111 structured audit logs", () => {
  it("logs a group membership permission update with identifiers only", async () => {
    const lines = capture();
    const app = appWith({
      groups: {
        updateMemberPermissions: async () => ({
          userId: USER,
          groupId: GROUP,
          organizationId: ORG,
          permissions,
        }),
      },
    });

    const response = await send(app)
      .put(
        `/organizations/${ORG}/groups/${GROUP}/memberships/${USER}/permissions`,
      )
      .send({ permissions });

    expect(response.status).toBe(200);
    expect(lines()).toContainEqual(
      expect.objectContaining({
        level: "info",
        event: "audit.group_member_permissions_updated",
        feature: "groups",
        action: "member_permissions_updated",
        organizationId: ORG,
        groupId: GROUP,
        actorUserId: ACTOR,
        targetUserId: USER,
      }),
    );
    expect(JSON.stringify(lines())).not.toMatch(
      /Secretname|123456785|readInvoices/,
    );
  });

  it("logs an organization membership permission update with identifiers only", async () => {
    const lines = capture();
    const app = appWith({
      organizations: {
        updateMembershipPermissions: async () => ({
          userId: USER,
          organizationId: ORG,
          role: "USER",
          permissions,
        }),
      },
    });

    const response = await send(app)
      .put(`/organizations/${ORG}/memberships/${USER}/permissions`)
      .send({ permissions });

    expect(response.status).toBe(200);
    expect(lines()).toContainEqual(
      expect.objectContaining({
        level: "info",
        event: "audit.org_member_permissions_updated",
        feature: "organizations",
        action: "member_permissions_updated",
        organizationId: ORG,
        actorUserId: ACTOR,
        targetUserId: USER,
      }),
    );
    expect(JSON.stringify(lines())).not.toMatch(/123456785|readInvoices/);
  });

  it("logs group membership add and remove", async () => {
    const lines = capture();
    const app = appWith({
      groups: {
        addMember: async () => ({
          userId: USER,
          groupId: GROUP,
          organizationId: ORG,
          permissions,
        }),
        removeMember: async () => {},
      },
    });

    await send(app)
      .post(`/organizations/${ORG}/groups/${GROUP}/memberships`)
      .send({ userId: USER });
    await send(app).delete(
      `/organizations/${ORG}/groups/${GROUP}/memberships/${USER}`,
    );

    expect(lines()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "audit.group_member_added",
          organizationId: ORG,
          groupId: GROUP,
          actorUserId: ACTOR,
          targetUserId: USER,
        }),
        expect.objectContaining({
          event: "audit.group_member_removed",
          organizationId: ORG,
          groupId: GROUP,
          actorUserId: ACTOR,
          targetUserId: USER,
        }),
      ]),
    );
  });

  it("logs organization membership add, role change and removal", async () => {
    const lines = capture();
    const membership = { userId: USER, organizationId: ORG, role: "ADMIN" };
    const app = appWith({
      organizations: {
        createMembership: async () => membership as never,
        changeMembershipRole: async () =>
          ({ membership, changed: true }) as never,
        removeMembership: async () => {},
      },
    });

    await send(app)
      .post(`/organizations/${ORG}/memberships`)
      .send({ rut: "123456785", role: "ADMIN" });
    await send(app)
      .patch(`/organizations/${ORG}/memberships/${USER}`)
      .send({ role: "USER" });
    await send(app).delete(`/organizations/${ORG}/memberships/${USER}`);

    const events = lines().map((line) => (line as { event: string }).event);
    expect(events).toEqual(
      expect.arrayContaining([
        "audit.org_member_added",
        "audit.org_member_role_changed",
        "audit.org_member_removed",
      ]),
    );
    expect(JSON.stringify(lines())).not.toMatch(/123456785|Secretname/);
    expect(lines()).toContainEqual(
      expect.objectContaining({
        event: "audit.org_member_removed",
        feature: "organizations",
        action: "member_removed",
        organizationId: ORG,
        actorUserId: ACTOR,
        targetUserId: USER,
      }),
    );
  });

  it("does not log a role change that kept the same role", async () => {
    const lines = capture();
    const membership = { userId: USER, organizationId: ORG, role: "USER" };
    const app = appWith({
      organizations: {
        changeMembershipRole: async () =>
          ({ membership, changed: false }) as never,
      },
    });

    const response = await send(app)
      .patch(`/organizations/${ORG}/memberships/${USER}`)
      .send({ role: "USER" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ membership });
    expect(lines()).toEqual([]);
  });

  it("does not log when the operation fails", async () => {
    const lines = capture();
    const app = appWith({
      groups: {
        removeMember: async () => {
          throw new Error("boom");
        },
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await send(app).delete(
      `/organizations/${ORG}/groups/${GROUP}/memberships/${USER}`,
    );

    expect(lines()).toEqual([]);
  });
});
