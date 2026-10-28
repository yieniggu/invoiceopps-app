import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { profileFixture } from "../../../test/transport";
import type { Profile } from "../types";
import { SessionStore } from "./sessionStore";

const ada = profileFixture() as unknown as Profile;
const bruno = profileFixture({
  id: "user-2",
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
    adaClient.setQueryData(["identity", "user-1", "workspace", "groups"], [1]);
    expect(adaClient.getQueryCache().getAll()).toHaveLength(2);

    expect(store.accept(adaClient, bruno)).toBe(true);

    expect(adaClient.getQueryCache().getAll()).toHaveLength(0);
    expect(store.getSnapshot().identityId).toBe("user-2");
  });

  it("does not store or fetch what an observer of the old tree builds afterwards", async () => {
    const store = new SessionStore();
    store.accept(store.getSnapshot().client, ada);
    const adaClient = store.getSnapshot().client;
    const queryFn = vi.fn(async () => "late");
    // The observer exists before the swap, like the one in the old tree.
    const observer = new QueryObserver(adaClient, {
      queryKey: ["identity", "user-1", "workspace", "groups"],
      queryFn,
      enabled: false,
    });

    store.end(adaClient, "logout");
    // The late call: setOptions with the options the old component renders.
    observer.setOptions({
      queryKey: ["identity", "user-1", "workspace", "groups"],
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
