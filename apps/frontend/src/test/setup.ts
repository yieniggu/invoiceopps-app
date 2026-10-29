import { configure } from "@testing-library/react";
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

/*
 * Wall-clock bound of findBy* and waitFor (Testing Library default: 1 s).
 *
 * The first App render of a test file is cold (module graph, React, router,
 * jsdom layout): 0.5-0.9 s on an idle 10-core machine and several seconds when
 * the machine is saturated. With the default bound the first test of a file
 * failed under load while the second passed (App.s8 "Panel principal" and "Mi
 * perfil", session.ui, routes.ui "redirects / to the panel", group-form "creates
 * the group"), reproduced with 8 workers plus 8 busy processes. The bound only
 * decides how long a wait that never succeeds takes to report: a wait that can
 * succeed returns as soon as its condition holds, so this does not slow passing
 * runs or hide a missing wait (a condition that never becomes true still fails).
 * Races that were real were fixed in the tests themselves (see CR-206/CR-240).
 */
if (typeof window !== "undefined") configure({ asyncUtilTimeout: 5000 });

/*
 * The shell's persistent live region repeats the text of the visible notice
 * card (that is how it gets announced). ByText queries look at what a person
 * sees, so they skip the screen-reader-only copy; the announcement itself is
 * proven in NoticeRegion.test.tsx, which queries the region directly.
 */
if (typeof window !== "undefined")
  configure({ defaultIgnore: "script, style, [data-notice-region] *" });
