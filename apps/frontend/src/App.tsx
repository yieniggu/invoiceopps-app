import { useState } from "react";
import { BrowserRouter } from "react-router";

import { useTheme } from "./lib/theme";
import { SessionProvider } from "./features/auth/components/SessionProvider";
import { SessionStore } from "./features/auth/session/sessionStore";
import { IdentityRouteGuard } from "./features/session/IdentityRouteGuard";
import { SessionGate } from "./features/session/SessionGate";

/**
 * Composition root. `sessionStore` is a test seam: production creates its own
 * store so each App instance owns exactly one chain of QueryClient partitions.
 */
export function App({ sessionStore }: { sessionStore?: SessionStore }) {
  // Keeps <html data-theme> in sync on every screen, even those without a toggle.
  useTheme();
  const [store] = useState(() => sessionStore ?? new SessionStore());
  return (
    <BrowserRouter>
      <IdentityRouteGuard store={store} />
      <SessionProvider store={store}>
        <SessionGate />
      </SessionProvider>
    </BrowserRouter>
  );
}
