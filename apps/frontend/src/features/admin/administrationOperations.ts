import { useEffect, useRef, useState } from "react";
import type { Profile } from "../profile/ProfileScreen";
import type { PlatformOrganization } from "../organizations/OrganizationsScreen";

export type MembershipRole = "ADMIN" | "USER";
export type MembershipMethod = "POST" | "PATCH" | "DELETE";
export type AdministrationIntent = {
  organizationId: string;
  organizationName: string;
  userId: string;
  role: MembershipRole;
  method: MembershipMethod;
};
export type AdministrationOperation = {
  intent: AdministrationIntent;
  kind: "pending" | "unknown" | "confirmed" | "rejected";
  status?: number;
  refreshFailed?: boolean;
  refreshing?: boolean;
};
export type AdministrationRefresh = (isCurrent: () => boolean) => Promise<{
  profile: Profile;
  organizations: PlatformOrganization[];
} | null>;
export class AdministrationReadError extends Error {
  constructor(readonly status: number) {
    super("Administration read failed");
  }
}
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function canAdministrate(profile: Profile) {
  return (
    profile.isPlatformAdministrator ||
    profile.memberships.some(({ role }) => role === "ADMIN")
  );
}
export function membershipKey(organizationId: string, userId: string) {
  return JSON.stringify([
    organizationId.toLowerCase(),
    userId.trim().toLowerCase(),
  ]);
}
export function useAdministrationOperations() {
  const operations = useRef(new Map<string, AdministrationOperation>());
  const active = useRef(true);
  const generation = useRef(0);
  const [, publish] = useState(0);
  const [draft, setDraft] = useState({
    organizationId: "",
    userId: "",
    role: "USER" as MembershipRole,
    method: "POST" as MembershipMethod,
  });
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const notify = () => {
    if (active.current) publish((value) => value + 1);
  };
  const reset = () => {
    generation.current += 1;
    operations.current.clear();
    setDraft({
      organizationId: "",
      userId: "",
      role: "USER",
      method: "POST",
    });
    notify();
  };
  const suspend = () => {
    // Logout invalidates preflight reads, not server-side effects already dispatched.
    for (const [key, operation] of operations.current) {
      if (operation.kind === "pending")
        operations.current.set(key, { ...operation, kind: "unknown" });
      else if (operation.refreshing)
        operations.current.set(key, {
          ...operation,
          refreshing: false,
          refreshFailed: true,
        });
    }
    notify();
  };
  const execute = async (
    intent: AdministrationIntent,
    refresh: AdministrationRefresh,
    sessionCurrent: () => boolean,
    unauthorized: () => void,
  ) => {
    const key = membershipKey(intent.organizationId, intent.userId);
    const prior = operations.current.get(key);
    if (
      !active.current ||
      !sessionCurrent() ||
      prior?.kind === "pending" ||
      prior?.kind === "unknown" ||
      prior?.refreshing ||
      (prior?.kind === "confirmed" && prior.refreshFailed)
    )
      return;
    if (
      !uuid.test(intent.organizationId) ||
      !uuid.test(intent.userId) ||
      !["ADMIN", "USER"].includes(intent.role) ||
      !["POST", "PATCH", "DELETE"].includes(intent.method)
    )
      return;
    const pending: AdministrationOperation = {
      intent: { ...intent },
      kind: "pending",
    };
    operations.current.set(key, pending);
    notify();
    const epoch = generation.current;
    let owned = pending;
    const isCurrent = () =>
      active.current &&
      generation.current === epoch &&
      sessionCurrent() &&
      operations.current.get(key) === owned;
    let dispatched = false;
    let confirmed = false;
    let outcome: AdministrationOperation;
    try {
      const fresh = await refresh(isCurrent);
      if (!isCurrent() || !fresh) return;
      if (
        !fresh.profile.isPlatformAdministrator ||
        !fresh.organizations.some((org) => org.id === intent.organizationId)
      )
        throw new AdministrationReadError(403);
      const path = `/platform/organizations/${encodeURIComponent(intent.organizationId)}/members${intent.method === "POST" ? "" : `/${encodeURIComponent(intent.userId)}`}`;
      dispatched = true;
      const response = await fetch(path, {
        method: intent.method,
        credentials: "same-origin",
        ...(intent.method === "DELETE"
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                intent.method === "POST"
                  ? { userId: intent.userId, role: intent.role }
                  : { role: intent.role },
              ),
            }),
      });
      if (!isCurrent()) return;
      if (response.status === 401) {
        unauthorized();
        return;
      }
      if (!response.ok) {
        outcome = {
          ...pending,
          kind: response.status >= 500 ? "unknown" : "rejected",
          status: response.status,
        };
      } else {
        if (intent.method === "DELETE") {
          if (response.status !== 204)
            throw new Error("Unexpected removal response");
        } else {
          const result: unknown = await response.json();
          if (!isCurrent()) return;
          if (
            !result ||
            typeof result !== "object" ||
            !("membership" in result)
          )
            throw new Error("Invalid membership response");
          const member = result.membership;
          if (
            !member ||
            typeof member !== "object" ||
            !("organizationId" in member) ||
            !("userId" in member) ||
            !("role" in member) ||
            member.organizationId !== intent.organizationId ||
            member.userId !== intent.userId ||
            member.role !== intent.role
          )
            throw new Error("Membership response intent mismatch");
        }
        confirmed = true;
        outcome = {
          ...pending,
          kind: "confirmed",
          refreshing: true,
          refreshFailed: true,
        };
        // Keep the receipt even when logout or navigation interrupts the following reads.
        operations.current.set(key, outcome);
        owned = outcome;
        notify();
        try {
          const refreshed = await refresh(isCurrent);
          if (!refreshed) return;
          outcome = { ...outcome, refreshing: false, refreshFailed: false };
        } catch {
          outcome = { ...outcome, refreshing: false, refreshFailed: true };
        }
      }
    } catch (error) {
      outcome = {
        ...pending,
        kind: confirmed ? "confirmed" : dispatched ? "unknown" : "rejected",
        ...(error instanceof AdministrationReadError
          ? { status: error.status }
          : {}),
        ...(confirmed ? { refreshFailed: true } : {}),
      };
    }
    if (!isCurrent()) return;
    operations.current.set(key, outcome);
    notify();
  };
  const retryRead = async (
    key: string,
    refresh: AdministrationRefresh,
    sessionCurrent: () => boolean,
  ) => {
    const observed = operations.current.get(key);
    if (
      observed?.kind !== "confirmed" ||
      !observed.refreshFailed ||
      observed.refreshing
    )
      return;
    const pending = { ...observed, refreshing: true };
    operations.current.set(key, pending);
    notify();
    const epoch = generation.current;
    const current = () =>
      active.current &&
      generation.current === epoch &&
      sessionCurrent() &&
      operations.current.get(key) === pending;
    try {
      const fresh = await refresh(current);
      if (fresh && current()) {
        operations.current.set(key, {
          ...observed,
          refreshing: false,
          refreshFailed: false,
        });
        notify();
      }
    } catch {
      if (current()) {
        operations.current.set(key, { ...observed, refreshing: false });
        notify();
      }
    }
  };
  return {
    draft,
    setDraft,
    operations: operations.current,
    execute,
    retryRead,
    reset,
    suspend,
  };
}
export type AdministrationController = ReturnType<
  typeof useAdministrationOperations
>;
