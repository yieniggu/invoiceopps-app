import { afterEach, beforeEach } from "vitest";

// BrowserRouter reads the real jsdom location: every test starts at "/".
// Node-environment suites (proxy checks) have no window.
const resetLocation = () => {
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
};
beforeEach(resetLocation);
afterEach(resetLocation);
