import { createContext, useContext, type ReactNode } from "react";

const ProtectedSession = createContext<() => void>(() => {});

export function ProtectedSessionProvider({
  onUnauthorized,
  children,
}: {
  onUnauthorized: () => void;
  children: ReactNode;
}) {
  return (
    <ProtectedSession.Provider value={onUnauthorized}>
      {children}
    </ProtectedSession.Provider>
  );
}

export function useUnauthorized() {
  return useContext(ProtectedSession);
}
