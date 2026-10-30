import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation } from "react-router";
import {
  Building2,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptText,
  SlidersHorizontal,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

import { NoticeRegionProvider } from "../../components/NoticeRegion";
import { ThemeToggle } from "../../components/ThemeToggle";
import { paths } from "./paths";

interface Destination {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Shown but not reachable yet: rendered as a disabled item, not a link. */
  comingSoon?: boolean;
}

export const primaryDestinations: Destination[] = [
  { label: "Panel principal", to: paths.dashboard, icon: LayoutDashboard },
  { label: "Facturas", to: paths.invoices, icon: ReceiptText },
  {
    label: "Políticas",
    to: paths.policies,
    icon: SlidersHorizontal,
    comingSoon: true,
  },
  { label: "Organizaciones", to: paths.organizations, icon: Building2 },
  { label: "Grupos", to: paths.groups, icon: Users },
];
const adminDestination: Destination = {
  label: "Admin",
  to: paths.admin,
  icon: ShieldCheck,
};
const profileDestination: Destination = {
  label: "Mi perfil",
  to: paths.profile,
  icon: UserRound,
};

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

// Group screens live under /organizations/:id/groups but belong to "Grupos".
const organizationGroupsPath = /^\/organizations\/[^/]+\/groups(\/|$)/;

function isDestinationActive(to: string, pathname: string) {
  if (organizationGroupsPath.test(pathname)) return to === paths.groups;
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * The page title is rendered by each screen's PageHeader. An open modal dialog
 * owns focus until it closes, so a navigation behind it leaves focus alone.
 */
const focusPageTitle = () => {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  document.getElementById("page-title")?.focus();
};

export function AppShell({
  children,
  onLogout,
  isLoggingOut,
  isPlatformAdministrator = false,
  showInvoices = true,
}: {
  children: ReactNode;
  /**
   * «Facturas» is offered to people with any invoice permission; being an
   * administrator of an organization is not one.
   */
  showInvoices?: boolean;
  /** Shows the Admin entry above the profile and logout items. */
  isPlatformAdministrator?: boolean;
  onLogout: () => void;
  isLoggingOut: boolean;
}) {
  const { pathname } = useLocation();
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Every URL change lands on the new page title (DOM synchronisation).
  useEffect(() => {
    focusPageTitle();
  }, [pathname]);

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
      if (target === "heading") focusPageTitle();
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

  // Following a link lands on the page title, even for the current URL.
  const navigate = () => {
    if (drawerOpen) closeDrawer("heading");
    else focusPageTitle();
  };

  // Close the drawer first so `main` is no longer inert and a logout error
  // rendered inside it stays perceivable.
  const logout = () => {
    if (drawerOpen) closeDrawer("heading");
    onLogout();
  };

  const labelClass = collapsed ? "nav-label visually-hidden" : "nav-label";
  const renderItem = ({ label, to, icon: Icon, comingSoon }: Destination) =>
    comingSoon ? (
      <li key={to}>
        {/* Not a link: it has no destination yet. aria-disabled keeps it
            focusable so its label and badge are still announced. */}
        <button
          type="button"
          className="nav-item is-disabled"
          aria-disabled="true"
          title={collapsed ? `${label} (Próximamente)` : undefined}
        >
          <Icon aria-hidden="true" focusable="false" size={20} />
          <span className="nav-text">
            <span className={labelClass}>{label}</span>{" "}
            <span className={collapsed ? "visually-hidden" : "nav-badge"}>
              Próximamente
            </span>
          </span>
        </button>
      </li>
    ) : (
      <li key={to}>
        <Link
          to={to}
          className="nav-item"
          aria-current={isDestinationActive(to, pathname) ? "page" : undefined}
          title={collapsed ? label : undefined}
          onClick={navigate}
        >
          <Icon aria-hidden="true" focusable="false" size={20} />
          <span className={labelClass}>{label}</span>
        </Link>
      </li>
    );
  const logoutLabel = isLoggingOut ? "Saliendo..." : "Salir";

  return (
    <NoticeRegionProvider>
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
          <div className="topbar-actions">
            <ThemeToggle />
          </div>
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
                <PanelLeftClose
                  aria-hidden="true"
                  focusable="false"
                  size={20}
                />
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
              {primaryDestinations
                .filter(({ to }) => showInvoices || to !== paths.invoices)
                .map(renderItem)}
            </ul>
            <ul className="nav-group nav-group-bottom">
              {isPlatformAdministrator ? (
                <>
                  {renderItem(adminDestination)}
                  <li role="separator" className="nav-divider" />
                </>
              ) : null}
              {renderItem(profileDestination)}
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
          {children}
        </main>
      </div>
    </NoticeRegionProvider>
  );
}
