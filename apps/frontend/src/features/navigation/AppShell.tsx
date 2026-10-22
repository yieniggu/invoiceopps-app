import { useEffect, useRef, type ReactNode } from "react";

export const destinations = [
  "Panel principal",
  "Mi perfil",
  "Organizaciones",
  "Mis grupos",
  "Recursos",
  "Facturas",
  "Políticas",
  "Evidencia y lotes",
  "Administración",
] as const;
export type Destination = (typeof destinations)[number];

export function AppShell({
  destination,
  onNavigate,
  children,
  canAdministrate = false,
}: {
  destination: Destination;
  onNavigate: (destination: Destination) => void;
  children: ReactNode;
  canAdministrate?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [destination]);
  return (
    <div className="shell app-shell">
      <p className="eyebrow">InvoiceOps</p>
      <a className="skip-link" href="#workspace-main">
        Saltar al contenido
      </a>
      <nav aria-label="Navegación principal">
        {destinations
          .filter((name) => name !== "Administración" || canAdministrate)
          .map((name) => (
            <button
              key={name}
              type="button"
              aria-current={destination === name ? "page" : undefined}
              onClick={() => onNavigate(name)}
            >
              {name}
            </button>
          ))}
      </nav>
      <main id="workspace-main" aria-labelledby="page-title" tabIndex={-1}>
        <h1 id="page-title" ref={heading} tabIndex={-1}>
          {destination}
        </h1>
        {children}
      </main>
    </div>
  );
}
