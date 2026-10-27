import { afterEach, beforeEach } from "vitest";

import { resetThemeForTests } from "../lib/theme";

// BrowserRouter reads the real jsdom location: every test starts at "/".
// Node-environment suites (proxy checks) have no window.
const resetLocation = () => {
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
};
beforeEach(resetLocation);
afterEach(resetLocation);

// Theme state lives on <html> and in localStorage: never leak it across tests.
const resetTheme = () => {
  if (typeof window === "undefined") return;
  resetThemeForTests();
  document.documentElement.removeAttribute("data-theme");
  try {
    window.localStorage.removeItem("invoiceops.theme");
  } catch {
    // Tests that make storage throw restore it themselves.
  }
};
beforeEach(resetTheme);
afterEach(resetTheme);
