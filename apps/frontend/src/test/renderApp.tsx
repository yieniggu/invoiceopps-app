import { render } from "@testing-library/react";
import { StrictMode } from "react";

import { App } from "../App";
import { SessionStore } from "../features/auth/session/sessionStore";

/**
 * Renders the real App with an inspectable session store. `route` seeds the
 * browser location, so a deep link or reload is exercised end to end.
 */
export function renderApp({
  strict = false,
  route = "/",
}: { strict?: boolean; route?: string } = {}) {
  window.history.replaceState(null, "", route);
  const store = new SessionStore();
  const tree = <App sessionStore={store} />;
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...view, store };
}
