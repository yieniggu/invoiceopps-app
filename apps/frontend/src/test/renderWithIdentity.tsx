import { render } from "@testing-library/react";
import type { ReactElement } from "react";

import { SessionProvider } from "../features/auth/components/SessionProvider";
import { SessionStore } from "../features/auth/session/sessionStore";
import { profileFixture } from "./transport";

/**
 * Renders a component that needs an authenticated identity partition (query
 * keys hang under the identity) without the rest of the app.
 */
export function renderWithIdentity(ui: ReactElement, identityId = "user-1") {
  const store = new SessionStore();
  store.accept(
    store.getSnapshot().client,
    profileFixture({ id: identityId }) as never,
  );
  const view = render(<SessionProvider store={store}>{ui}</SessionProvider>);
  return { ...view, store };
}
