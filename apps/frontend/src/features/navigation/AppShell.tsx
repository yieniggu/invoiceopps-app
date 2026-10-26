import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Building2,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

export const destinations = [
  "Panel principal",
  "Mi perfil",
  "Organizaciones",
  "Mis grupos",
  "Facturas",
  "Políticas",
  "Administración",
] as const;
export type Destination = (typeof destinations)[number];

const destinationIcons: Record<Destination, LucideIcon> = {
  "Panel principal": LayoutDashboard,
  Facturas: ReceiptText,
  Políticas: SlidersHorizontal,
  Organizaciones: Building2,
  "Mis grupos": Users,
  Administración: ShieldCheck,
  "Mi perfil": UserRound,
};

const primaryItems: Destination[] = [
  "Panel principal",
  "Facturas",
  "Políticas",
  "Organizaciones",
  "Mis grupos",
  "Administración",
];

export const SIDEBAR_COLLAPSED_KEY = "invoiceops.sidebar.collapsed";

export function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Storage may be blocked; the preference is a convenience only.
  }
}

export function AppShell({
  destination,
  onNavigate,
  children,
  canAdministrate = false,
  onLogout,
  isLoggingOut,
}: {
  destination: Destination;
  onNavigate: (destination: Destination) => void;
  children: ReactNode;
  canAdministrate?: boolean;
  onLogout: () => void;
  isLoggingOut: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    heading.current?.focus();
  }, [destination]);

  // Focus can only move once the closed drawer has removed `inert` from the
  // trigger and the page, so the target is applied after the commit.
  const pendingFocus = useRef<"trigger" | "heading" | null>(null);
  const closeDrawer = useCallback((focusTarget: "trigger" | "heading") => {
    pendingFocus.current = focusTarget;
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    if (!drawerOpen) {
      const target = pendingFocus.current;
      pendingFocus.current = null;
      if (target === "trigger") drawerTrigger.current?.focus();
      if (target === "heading") heading.current?.focus();
      return;
    }
    drawerClose.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer("trigger");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, closeDrawer]);

  // The drawer only exists on narrow screens (max-width: 768px, the same
  // breakpoint as the CSS). When the viewport leaves that range the drawer
  // closes and focus moves to the page title.
  useEffect(() => {
    if (!drawerOpen) return;
    if (typeof window.matchMedia === "function") {
      const query = window.matchMedia("(max-width: 768px)");
      const onChange = (event: { matches: boolean }) => {
        if (!event.matches) closeDrawer("heading");
      };
      if (!query.matches) closeDrawer("heading");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    const onResize = () => {
      if (window.innerWidth > 768) closeDrawer("heading");
    };
    // Without matchMedia the width is checked right away, like the query path.
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [drawerOpen, closeDrawer]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  };

  const navigate = (name: Destination) => {
    onNavigate(name);
    // Navigation lands on the page title, even when the destination is unchanged.
    if (drawerOpen) closeDrawer("heading");
  };

  // Close the drawer first so `main` is no longer inert and a logout error
  // rendered inside it stays perceivable.
  const logout = () => {
    if (drawerOpen) closeDrawer("heading");
    onLogout();
  };

  const labelClass = collapsed ? "nav-label visually-hidden" : "nav-label";
  const renderItem = (name: Destination) => {
    const Icon = destinationIcons[name];
    return (
      <li key={name}>
        <button
          type="button"
          className="nav-item"
          title={collapsed ? name : undefined}
          aria-current={destination === name ? "page" : undefined}
          onClick={() => navigate(name)}
        >
          <Icon aria-hidden="true" focusable="false" size={20} />
          <span className={labelClass}>{name}</span>
        </button>
      </li>
    );
  };
  const logoutLabel = isLoggingOut ? "Saliendo..." : "Salir";

  return (
    <div
      className={`app-shell app-layout${collapsed ? " is-collapsed" : ""}${drawerOpen ? " is-drawer-open" : ""}`}
    >
      <a className="skip-link" href="#workspace-main" inert={drawerOpen}>
        Saltar al contenido
      </a>
      <header className="topbar" inert={drawerOpen}>
        <button
          ref={drawerTrigger}
          type="button"
          className="icon-button"
          aria-label="Abrir menú"
          aria-expanded={drawerOpen}
          aria-controls="app-sidebar"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu aria-hidden="true" focusable="false" size={20} />
        </button>
        <span className="topbar-brand" aria-hidden="true">
          InvoiceOps
        </span>
      </header>
      {drawerOpen ? (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => closeDrawer("trigger")}
        />
      ) : null}
      <aside id="app-sidebar" className="sidebar">
        <div className="sidebar-header">
          <p className="sidebar-brand">InvoiceOps</p>
          <button
            type="button"
            className="icon-button sidebar-collapse-toggle"
            aria-label={collapsed ? "Expandir menú" : "Contraer menú"}
            onClick={toggleCollapsed}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" focusable="false" size={20} />
            ) : (
              <PanelLeftClose aria-hidden="true" focusable="false" size={20} />
            )}
          </button>
          <button
            ref={drawerClose}
            type="button"
            className="icon-button sidebar-drawer-close"
            aria-label="Cerrar menú"
            onClick={() => closeDrawer("trigger")}
          >
            <X aria-hidden="true" focusable="false" size={20} />
          </button>
        </div>
        <nav id="app-sidebar-nav" aria-label="Navegación principal">
          <ul className="nav-group">
            {primaryItems
              .filter((name) => name !== "Administración" || canAdministrate)
              .map(renderItem)}
          </ul>
          <ul className="nav-group nav-group-bottom">
            {renderItem("Mi perfil")}
            <li>
              <button
                type="button"
                className="nav-item"
                title={collapsed ? "Salir" : undefined}
                disabled={isLoggingOut}
                onClick={logout}
              >
                <LogOut aria-hidden="true" focusable="false" size={20} />
                <span className={labelClass}>{logoutLabel}</span>
              </button>
            </li>
          </ul>
        </nav>
      </aside>
      <main
        id="workspace-main"
        aria-labelledby="page-title"
        tabIndex={-1}
        inert={drawerOpen}
      >
        <h1 id="page-title" ref={heading} tabIndex={-1}>
          {destination}
        </h1>
        {children}
      </main>
    </div>
  );
}
