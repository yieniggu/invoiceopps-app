import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

import { createQueryClient } from "../features/auth/session/createQueryClient";

/** Renders a component that uses Query hooks with a real, isolated client. */
export function renderWithClient(ui: ReactElement) {
  const client = createQueryClient({ onUnauthorized: () => {} });
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
}
