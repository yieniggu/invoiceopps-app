import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { profileFixture } from "../../../test/transport";
import type { Profile } from "../types";
import { profileKey } from "./queryKeys";
import { SessionStore } from "./sessionStore";

const ada = profileFixture() as unknown as Profile;
const bruno = profileFixture({
  id: "00000000-0000-4000-8000-000000000002",
  name: "Bruno",
}) as unknown as Profile;

// React flushes the passive effects of the last commit of the previous
// identity's tree lazily: an observer of that tree can call `setOptions` after
// the partition swap. These tests reproduce that call directly.
describe("a retired partition stays empty and idle", () => {
  it("clears the previous client when another person answers", () => {
    const store = new SessionStore();
    const first = store.getSnapshot().client;
    store.accept(first, ada);
    const adaClient = store.getSnapshot().client;
    adaClient.setQueryData(
      [
        "identity",
        "00000000-0000-4000-8000-000000000001",
        "workspace",
        "groups",
      ],
      [1],
    );
    expect(adaClient.getQueryCache().getAll()).toHaveLength(2);

    expect(store.accept(adaClient, bruno)).toBe(true);

    expect(adaClient.getQueryCache().getAll()).toHaveLength(0);
    expect(store.getSnapshot().identityId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
  });

  it("does not store or fetch what an observer of the old tree builds afterwards", async () => {
    const store = new SessionStore();
    store.accept(store.getSnapshot().client, ada);
    const adaClient = store.getSnapshot().client;
    const queryFn = vi.fn(async () => "late");
    // The observer exists before the swap, like the one in the old tree.
    const observer = new QueryObserver(adaClient, {
      queryKey: [
        "identity",
        "00000000-0000-4000-8000-000000000001",
        "workspace",
        "groups",
      ],
      queryFn,
      enabled: false,
    });

    store.end(adaClient, "logout");
    // The late call: setOptions with the options the old component renders.
    observer.setOptions({
      queryKey: [
        "identity",
        "00000000-0000-4000-8000-000000000001",
        "workspace",
        "groups",
      ],
      queryFn,
      enabled: true,
    });
    const unsubscribe = observer.subscribe(() => {});
    await Promise.resolve();

    expect(queryFn).not.toHaveBeenCalled();
    expect(adaClient.getQueryCache().getAll()).toHaveLength(0);
    unsubscribe();
  });

  it("keeps the live partition fully functional", async () => {
    const store = new SessionStore();
    const client = store.getSnapshot().client;
    const queryFn = vi.fn(async () => "fresh");

    const value = await client.fetchQuery({ queryKey: ["live"], queryFn });

    expect(value).toBe("fresh");
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().getAll()).toHaveLength(1);
  });

  it("retires a client only once it is swapped out, never a stale transition", () => {
    const store = new SessionStore();
    const first = store.getSnapshot().client;
    store.accept(first, ada);
    const adaClient = store.getSnapshot().client;
    adaClient.setQueryData(["keep"], 1);

    // A transition requested by a client that is no longer current is ignored.
    store.end(first, "logout");

    expect(store.getSnapshot().client).toBe(adaClient);
    expect(adaClient.getQueryData(["keep"])).toBe(1);
  });
});

describe("keepRoute", () => {
  const adaClientOf = (store: SessionStore) => {
    store.accept(store.getSnapshot().client, ada);
    return store.getSnapshot().client;
  };

  it("is false by default and after a plain begin", () => {
    const store = new SessionStore();
    expect(store.getSnapshot().keepRoute).toBe(false);
    store.begin(adaClientOf(store));
    expect(store.getSnapshot().keepRoute).toBe(false);
  });

  it("is exposed by begin with keepRoute and reset by accept and end", () => {
    const store = new SessionStore();
    store.begin(adaClientOf(store), { keepRoute: true });
    expect(store.getSnapshot().keepRoute).toBe(true);

    // Another person answering ends the continuation.
    store.accept(store.getSnapshot().client, bruno);
    expect(store.getSnapshot().keepRoute).toBe(false);

    store.begin(store.getSnapshot().client, { keepRoute: true });
    expect(store.getSnapshot().keepRoute).toBe(true);
    store.end(store.getSnapshot().client, "logout");
    expect(store.getSnapshot().keepRoute).toBe(false);
  });

  it("seeds the new partition with the same person's stale profile", () => {
    const store = new SessionStore();
    const before = adaClientOf(store);

    store.begin(before, { keepRoute: true });

    const after = store.getSnapshot();
    expect(after.client).not.toBe(before);
    expect(after.phase).toBe("identity");
    expect(after.identityId).toBe(ada.id);
    const state = after.client.getQueryState(profileKey(ada.id));
    expect(state?.data).toEqual(ada);
    // Fresh for no time at all: the first observer refetches it.
    expect(
      after.client
        .getQueryCache()
        .find({ queryKey: profileKey(ada.id) })
        ?.isStaleByTime(30_000),
    ).toBe(true);
    expect(before.getQueryCache().getAll()).toHaveLength(0);
  });

  it("does not seed without keepRoute or without a cached profile", () => {
    const store = new SessionStore();
    store.begin(adaClientOf(store));
    expect(store.getSnapshot().phase).toBe("unknown");
    expect(store.getSnapshot().client.getQueryCache().getAll()).toHaveLength(0);

    const other = new SessionStore();
    const client = adaClientOf(other);
    client.clear();
    other.begin(client, { keepRoute: true });
    expect(other.getSnapshot().phase).toBe("unknown");
    expect(other.getSnapshot().identityId).toBeNull();
    expect(other.getSnapshot().keepRoute).toBe(true);
  });
});
