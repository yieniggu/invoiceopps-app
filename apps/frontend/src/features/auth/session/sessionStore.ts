import type { QueryClient } from "@tanstack/react-query";

import type { Profile } from "../types";
import { createQueryClient, retireQueryClient } from "./createQueryClient";
import { profileKey } from "./queryKeys";

/**
 * Who owns the current QueryClient.
 * - unknown: the profile is not resolved yet; an ephemeral client serves it.
 * - identity: the client is partitioned for one person.
 * - anonymous: nobody is signed in; the client is empty.
 */
export type SessionPhase = "unknown" | "identity" | "anonymous";

/** Why nobody is signed in: the person chose to, or the server said 401. */
export type SessionEnd = "logout" | "unauthorized";

export interface SessionSnapshot {
  readonly client: QueryClient;
  readonly phase: SessionPhase;
  readonly identityId: string | null;
  /** Set only while anonymous after a transition; null before any sign-in. */
  readonly endedBy: SessionEnd | null;
  /** Changes with every client; screens are remounted per generation. */
  readonly generation: number;
  /**
   * The same person starts over where they are (a password change from the
   * profile): the route guard must not send them back to the panel.
   */
  readonly keepRoute: boolean;
}

/**
 * Owns the QueryClient partitions. Every transition retires the previous
 * client (cancel requests, drop query and mutation caches) before the next
 * identity renders, and any transition requested by a stale client is
 * ignored so a late response never repopulates someone else's partition.
 */
export class SessionStore {
  private snapshot: SessionSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.snapshot = this.create("unknown", null, 0, null);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /**
   * Start over with an ephemeral client (after login or password change).
   * With `keepRoute` the same person continues in place: their cached profile
   * seeds the new partition (already stale, so it is refetched at once) and the
   * screens render without going through the loading state. Another identity
   * is never seeded.
   */
  begin(
    from: QueryClient = this.snapshot.client,
    { keepRoute = false }: { keepRoute?: boolean } = {},
  ) {
    if (from !== this.snapshot.client) return;
    const { phase, identityId } = this.snapshot;
    // Read before replacing: retiring the client drops its caches.
    const profile =
      keepRoute && phase === "identity" && identityId
        ? from.getQueryData<Profile>(profileKey(identityId))
        : undefined;
    if (profile && identityId) {
      this.replace(
        "identity",
        identityId,
        (client) =>
          client.setQueryData(profileKey(identityId), profile, {
            updatedAt: 0,
          }),
        null,
        true,
      );
      return;
    }
    this.replace("unknown", null, undefined, null, keepRoute);
  }

  /**
   * Nobody is signed in: a voluntary logout, or a 401 (expired session or
   * rejected profile). The reason decides which notice the login shows.
   */
  end(
    from: QueryClient = this.snapshot.client,
    reason: SessionEnd = "unauthorized",
  ) {
    // Already signed out: a 401 here is a rejected login, not an expired session.
    if (from !== this.snapshot.client || this.snapshot.phase === "anonymous")
      return;
    this.replace("anonymous", null, undefined, reason);
  }

  /**
   * The profile resolved for `from`. Adopts an identity partition, or swaps
   * it when a different person answers. Returns false for a stale client.
   */
  accept(from: QueryClient, profile: Profile) {
    const current = this.snapshot;
    if (from !== current.client) return false;
    if (current.phase === "identity" && current.identityId === profile.id)
      return true;
    this.replace("identity", profile.id, (client) =>
      client.setQueryData(profileKey(profile.id), profile),
    );
    return true;
  }

  private create(
    phase: SessionPhase,
    identityId: string | null,
    generation: number,
    endedBy: SessionEnd | null,
    keepRoute = false,
  ): SessionSnapshot {
    const client: QueryClient = createQueryClient({
      onUnauthorized: () => this.end(client),
    });
    return { client, phase, identityId, endedBy, generation, keepRoute };
  }

  private replace(
    phase: SessionPhase,
    identityId: string | null,
    seed?: (client: QueryClient) => void,
    endedBy: SessionEnd | null = null,
    keepRoute = false,
  ) {
    const previous = this.snapshot;
    retireQueryClient(previous.client);
    const next = this.create(
      phase,
      identityId,
      previous.generation + 1,
      endedBy,
      keepRoute,
    );
    seed?.(next.client);
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
