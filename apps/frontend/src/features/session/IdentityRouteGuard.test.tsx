import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../auth/session/sessionStore";
import type { Profile } from "../auth/types";
import { profileFixture } from "../../test/transport";
import { IdentityRouteGuard } from "./IdentityRouteGuard";

afterEach(cleanup);

const ada = profileFixture() as unknown as Profile;

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function setup() {
  const store = new SessionStore();
  store.accept(store.getSnapshot().client, ada);
  render(
    <MemoryRouter initialEntries={["/profile"]}>
      <IdentityRouteGuard store={store} />
      <Where />
    </MemoryRouter>,
  );
  return store;
}

const where = () => screen.getByTestId("where").textContent;

describe("IdentityRouteGuard", () => {
  it("returns to the panel when the identity changes", () => {
    const store = setup();
    expect(where()).toBe("/profile");

    act(() => store.begin(store.getSnapshot().client));

    expect(where()).toBe("/dashboard");
  });

  it("keeps the current route when the change asks to keep it", () => {
    const store = setup();
    const client = store.getSnapshot().client;
    // No cached profile to seed: the identity really becomes unknown.
    client.clear();

    act(() => store.begin(client, { keepRoute: true }));

    expect(store.getSnapshot().identityId).toBeNull();
    expect(where()).toBe("/profile");
  });
});
