import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { AuthScreen } from "./features/auth/AuthScreen";
import { ProtectedSessionProvider } from "./features/auth/ProtectedSession";
import { InvoiceDecisionsProvider } from "./features/invoices/InvoiceDecisions";
import { ResourceContext } from "./features/resources/ResourceContext";
import { InvoiceWorkspace } from "./features/invoices/InvoiceWorkspace";
import { AppShell, type Destination } from "./features/navigation/AppShell";
import { ProfileScreen, type Profile } from "./features/profile/ProfileScreen";
import {
  OrganizationsScreen,
  type PlatformOrganizationsState,
} from "./features/organizations/OrganizationsScreen";
import {
  GroupsScreen,
  type Group,
  type GroupsState,
} from "./features/groups/GroupsScreen";
import { DashboardScreen } from "./features/dashboard/DashboardScreen";
import { PoliciesScreen } from "./features/policies/PoliciesScreen";
import { PolicyMutationsProvider } from "./features/policies/PolicyMutationsContext";
import { EvidenceScreen } from "./features/evidence/EvidenceScreen";
import { AdministrationScreen } from "./features/admin/AdministrationScreen";
import { useGroupOperations } from "./features/groups/groupOperations";
import {
  AdministrationReadError,
  canAdministrate,
  useAdministrationOperations,
} from "./features/admin/administrationOperations";
import {
  WorkspaceBoundary,
  WorkspaceProvider,
  WorkspaceSummary,
} from "./features/workspace/WorkspaceContext";

type ProfileState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "error" }
  | { kind: "authenticated"; profile: Profile };

async function requestProfile() {
  const response = await fetch("/profile", { credentials: "same-origin" });

  if (response.status === 401) {
    return { kind: "anonymous" } as const;
  }

  if (!response.ok) {
    throw new Error("Profile request failed");
  }

  const { profile } = (await response.json()) as { profile: Profile };
  return { kind: "authenticated", profile } as const;
}

class ProtectedReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function requestGroups() {
  const response = await fetch("/groups", { credentials: "same-origin" });

  if (!response.ok) {
    throw new ProtectedReadError("Groups request failed", response.status);
  }

  return (await response.json()) as { groups: Group[] };
}

async function requestPlatformOrganizations() {
  const response = await fetch("/platform/organizations", {
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new ProtectedReadError(
      "Platform organization request failed",
      response.status,
    );
  }

  return (await response.json()) as {
    organizations: Extract<
      PlatformOrganizationsState,
      { kind: "loaded" }
    >["organizations"];
  };
}

export function App() {
  const administration = useAdministrationOperations();
  const groupOperations = useGroupOperations();
  const [groupReadRevision, setGroupReadRevision] = useState(0);
  const [state, setState] = useState<ProfileState>({ kind: "loading" });
  const [groupsState, setGroupsState] = useState<GroupsState>({ kind: "idle" });
  const [platformOrganizationsState, setPlatformOrganizationsState] =
    useState<PlatformOrganizationsState>({ kind: "idle" });
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [message, setMessage] = useState<string>();
  const [logoutError, setLogoutError] = useState<string>();
  const [groupError, setGroupError] = useState<string>();
  const [isMutatingGroup, setIsMutatingGroup] = useState(false);
  const [groupOperation, setGroupOperation] = useState<string>();
  const [groupMessage, setGroupMessage] = useState<string>();
  const [destination, setDestination] =
    useState<Destination>("Panel principal");
  // Every App-owned operation belongs to one session epoch, including logout.
  // Invalidating UI work does not roll back requests already received by the server.
  const session = useRef({ epoch: 0, active: false });
  // Authority ordering is separate from session ownership: refreshing roles
  // must not reset policy, invoice or administration mutation ledgers.
  const authorityRevision = useRef(0);

  useLayoutEffect(() => {
    const title =
      state.kind === "authenticated"
        ? destination
        : state.kind === "anonymous"
          ? "Iniciar sesión"
          : state.kind === "loading"
            ? "Cargando sesión"
            : "Sesión no disponible";
    document.title = `${title} · InvoiceOps`;
  }, [state.kind, destination]);

  const beginSessionEpoch = useCallback((active: boolean) => {
    authorityRevision.current += 1;
    session.current = { epoch: session.current.epoch + 1, active };
    setIsSaving(false);
    setIsLoggingOut(false);
    setIsMutatingGroup(false);
    setMessage(undefined);
    setLogoutError(undefined);
    setGroupError(undefined);
    setGroupOperation(undefined);
    setGroupMessage(undefined);
    return session.current.epoch;
  }, []);

  const endSession = useCallback(() => {
    groupOperations.reset();
    administration.reset();
    beginSessionEpoch(false);
    setState({ kind: "anonymous" });
    setGroupsState({ kind: "idle" });
    setPlatformOrganizationsState({ kind: "idle" });
    setEmail("");
    setUsername("");
    setDestination("Panel principal");
  }, [beginSessionEpoch]);

  const epoch = session.current.epoch;
  const onUnauthorized = useCallback(() => {
    if (session.current.active && session.current.epoch === epoch) endSession();
  }, [epoch, endSession]);

  const loadProfile = async () => {
    groupOperations.reset();
    administration.reset();
    const epoch = beginSessionEpoch(true);
    const revision = ++authorityRevision.current;
    const isCurrent = () =>
      session.current.epoch === epoch && authorityRevision.current === revision;
    setState({ kind: "loading" });
    setGroupsState({ kind: "idle" });
    setPlatformOrganizationsState({ kind: "idle" });
    setDestination("Panel principal");

    try {
      const result = await requestProfile();
      if (!isCurrent()) return;
      if (result.kind === "authenticated") {
        setState(result);
        setEmail(result.profile.email ?? "");
        setUsername(result.profile.username ?? "");
        if (result.profile.isPlatformAdministrator) {
          setPlatformOrganizationsState({ kind: "loading" });
          try {
            const discovery = await requestPlatformOrganizations();
            if (!isCurrent()) return;
            setPlatformOrganizationsState({ kind: "loaded", ...discovery });
          } catch (error) {
            if (!isCurrent()) return;
            if (error instanceof ProtectedReadError && error.status === 401) {
              endSession();
              return;
            }
            setPlatformOrganizationsState({ kind: "error" });
          }

          if (result.profile.memberships.length > 0) {
            setGroupsState({ kind: "loading" });
            try {
              const groups = await requestGroups();
              if (!isCurrent()) return;
              setGroupsState({ kind: "loaded", ...groups });
            } catch (error) {
              if (!isCurrent()) return;
              if (error instanceof ProtectedReadError && error.status === 401) {
                endSession();
                return;
              }
              setGroupsState({ kind: "error" });
            }
          } else {
            setGroupsState({ kind: "loaded", groups: [] });
          }
        } else if (result.profile.memberships.length > 0) {
          setGroupsState({ kind: "loading" });
          try {
            const groups = await requestGroups();
            if (!isCurrent()) return;
            setGroupsState({ kind: "loaded", ...groups });
          } catch (error) {
            if (!isCurrent()) return;
            if (error instanceof ProtectedReadError && error.status === 401) {
              endSession();
              return;
            }
            setGroupsState({ kind: "error" });
          }
        } else {
          setGroupsState({ kind: "loaded", groups: [] });
        }
      } else {
        endSession();
      }
    } catch {
      if (!isCurrent()) return;
      setState({ kind: "error" });
    }
  };

  const reloadGroups = async (epoch = session.current.epoch) => {
    const completeConfirmedReads = groupOperations.beginRead();
    const revision = ++authorityRevision.current;
    const isCurrent = () =>
      session.current.epoch === epoch && authorityRevision.current === revision;
    if (
      !isCurrent() ||
      !session.current.active ||
      state.kind !== "authenticated"
    ) {
      return false;
    }

    setGroupError(undefined);
    setGroupsState({ kind: "loading" });
    let discoveryLoaded = true;
    try {
      if (state.profile.isPlatformAdministrator) {
        setPlatformOrganizationsState({ kind: "loading" });
        try {
          const discovery = await requestPlatformOrganizations();
          if (!isCurrent()) return;
          setPlatformOrganizationsState({ kind: "loaded", ...discovery });
        } catch (error) {
          if (!isCurrent()) return;
          if (error instanceof ProtectedReadError && error.status === 401) {
            endSession();
            return;
          }
          setPlatformOrganizationsState({ kind: "error" });
          discoveryLoaded = false;
        }
        if (state.profile.memberships.length > 0) {
          const result = await requestGroups();
          if (!isCurrent()) return;
          setGroupsState({ kind: "loaded", ...result });
        } else {
          setGroupsState({ kind: "loaded", groups: [] });
        }
      } else if (state.profile.memberships.length > 0) {
        const result = await requestGroups();
        if (!isCurrent()) return;
        setGroupsState({ kind: "loaded", ...result });
      } else {
        setGroupsState({ kind: "loaded", groups: [] });
      }
      setGroupReadRevision((value) => value + 1);
      if (discoveryLoaded) completeConfirmedReads();
      return discoveryLoaded;
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ProtectedReadError && error.status === 401) {
        endSession();
        return;
      }
      setGroupsState({ kind: "error" });
      return false;
    }
  };

  const mutateGroup = async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
    label?: string,
  ) => {
    if (
      !session.current.active ||
      state.kind !== "authenticated" ||
      groupOperations.blocked(path, method, body)
    )
      return;
    const epoch = session.current.epoch;
    const operation = groupOperations.begin({
      path,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      label,
    });
    if (!operation) return;
    const isCurrent = () =>
      session.current.active &&
      session.current.epoch === epoch &&
      operation.current();
    setIsMutatingGroup(true);
    setGroupError(undefined);
    setGroupMessage(undefined);
    setGroupOperation(label);
    try {
      const response = await fetch(operation.intent.path, {
        method: operation.intent.method,
        credentials: "same-origin",
        ...(operation.intent.body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: operation.intent.body,
            }),
      });

      if (!isCurrent()) return;
      if (response.status === 401) {
        endSession();
        return;
      }

      if (!response.ok) {
        operation.finish(
          response.status >= 400 && response.status < 500
            ? "rejected"
            : "unknown",
        );
        setGroupError(
          response.status >= 400 && response.status < 500
            ? "No fue posible actualizar los grupos. Revisa los datos y permisos antes de intentar nuevamente."
            : undefined,
        );
        return;
      }

      // Headers are the acknowledgement. A body/refresh failure cannot turn a
      // confirmed write into a resend. DELETE 204 has no JSON body.
      operation.finish("confirmed", true);
      const refreshed = await reloadGroups(epoch);
      if (session.current.epoch === epoch && session.current.active)
        setGroupMessage(
          refreshed
            ? "Cambio guardado. Los grupos se han actualizado."
            : "Cambio guardado. Reintenta la consulta para actualizar la lista; no repitas la operación.",
        );
    } catch {
      if (!isCurrent()) return;
      operation.finish("unknown");
    } finally {
      if (session.current.epoch === epoch) setIsMutatingGroup(false);
    }
  };

  useEffect(() => {
    void loadProfile();
    return () => {
      session.current = { epoch: session.current.epoch + 1, active: false };
    };
  }, []);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session.current.active || state.kind !== "authenticated" || isSaving)
      return;
    const epoch = session.current.epoch;
    const isCurrent = () => session.current.epoch === epoch;
    setIsSaving(true);
    setMessage(undefined);

    try {
      const response = await fetch("/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, username }),
      });

      if (!isCurrent()) return;
      if (response.status === 401) {
        endSession();
        return;
      }

      if (!response.ok) {
        throw new Error("Profile update failed");
      }

      const { profile } = (await response.json()) as { profile: Profile };
      if (!isCurrent()) return;
      if (profile.id !== state.profile.id)
        throw new Error("Profile actor mismatch");
      setState((current) =>
        current.kind === "authenticated" && current.profile.id === profile.id
          ? {
              ...current,
              profile: {
                ...current.profile,
                email: profile.email,
                username: profile.username,
              },
            }
          : current,
      );
      setEmail(profile.email ?? "");
      setUsername(profile.username ?? "");
      setMessage("Perfil actualizado.");
    } catch {
      if (!isCurrent()) return;
      setMessage("No fue posible actualizar el perfil. Intenta nuevamente.");
    } finally {
      if (isCurrent()) setIsSaving(false);
    }
  };

  const logout = async () => {
    if (!session.current.active || state.kind !== "authenticated") return;
    administration.suspend();
    groupOperations.suspend();
    const epoch = beginSessionEpoch(false);
    const isCurrent = () => session.current.epoch === epoch;
    setIsLoggingOut(true);
    setLogoutError(undefined);

    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });

      if (!isCurrent()) return;
      if (response.status === 401) {
        endSession();
        return;
      }

      if (!response.ok) {
        throw new Error("Logout request failed");
      }

      endSession();
    } catch {
      if (!isCurrent()) return;
      session.current.active = true;
      setLogoutError("No fue posible cerrar la sesión. Intenta nuevamente.");
      // A failed logout keeps the current identity, but invalidated reads need a fresh attempt.
      if (
        groupsState.kind === "loading" ||
        platformOrganizationsState.kind === "loading"
      ) {
        void reloadGroups(epoch);
      }
    } finally {
      if (isCurrent()) setIsLoggingOut(false);
    }
  };

  if (state.kind === "loading") {
    return (
      <main className="shell" aria-labelledby="page-title">
        <p className="eyebrow">InvoiceOps</p>
        <h1 id="page-title">Mi perfil</h1>
        <p role="status">Cargando perfil...</p>
      </main>
    );
  }

  if (state.kind === "anonymous") {
    return <AuthScreen onLogin={() => void loadProfile()} />;
  }

  if (state.kind === "error") {
    return (
      <main className="shell" aria-labelledby="page-title">
        <p className="eyebrow">InvoiceOps</p>
        <h1 id="page-title">Mi perfil</h1>
        <p role="alert">No fue posible cargar el perfil.</p>
        <button type="button" onClick={() => void loadProfile()}>
          Reintentar
        </button>
      </main>
    );
  }

  const { profile } = state;

  const administrationEpoch = session.current.epoch;
  const administrationSessionCurrent = () =>
    session.current.active && session.current.epoch === administrationEpoch;
  const refreshAdministration = async (operationCurrent: () => boolean) => {
    if (!administrationSessionCurrent() || !operationCurrent()) return null;
    const revision = ++authorityRevision.current;
    const isCurrent = () =>
      administrationSessionCurrent() &&
      operationCurrent() &&
      authorityRevision.current === revision;
    const superseded = () => {
      if (administrationSessionCurrent() && operationCurrent())
        throw new AdministrationReadError(0);
      return null;
    };
    if (!isCurrent()) return null;
    setGroupsState({ kind: "loading" });
    let organizations: Extract<
      PlatformOrganizationsState,
      { kind: "loaded" }
    >["organizations"] = [];
    try {
      const result = await requestProfile();
      if (!isCurrent()) return superseded();
      if (result.kind !== "authenticated" || result.profile.id !== profile.id) {
        endSession();
        return null;
      }
      // Same-actor capability refresh must not remount unrelated mutation ledgers.
      const fresh = result.profile;
      setState((current) =>
        current.kind === "authenticated" && current.profile.id === fresh.id
          ? {
              kind: "authenticated",
              profile: {
                ...fresh,
                email: current.profile.email,
                username: current.profile.username,
              },
            }
          : current,
      );
      setPlatformOrganizationsState({ kind: "idle" });
      if (fresh.isPlatformAdministrator) {
        const discovery = await requestPlatformOrganizations();
        if (!isCurrent()) return superseded();
        organizations = discovery.organizations;
        setPlatformOrganizationsState({ kind: "loaded", organizations });
      }
      const groups = fresh.memberships.length
        ? await requestGroups()
        : { groups: [] };
      if (!isCurrent()) return superseded();
      setGroupsState({ kind: "loaded", ...groups });
      setGroupReadRevision((value) => value + 1);
      return { profile: fresh, organizations };
    } catch (error) {
      if (!isCurrent()) return superseded();
      if (error instanceof ProtectedReadError && error.status === 401) {
        endSession();
        return null;
      }
      setGroupsState({ kind: "error" });
      setPlatformOrganizationsState({ kind: "error" });
      throw new AdministrationReadError(
        error instanceof ProtectedReadError ? error.status : 0,
      );
    }
  };
  const retryAdministrationDiscovery = async () => {
    try {
      await refreshAdministration(administrationSessionCurrent);
    } catch {
      if (administrationSessionCurrent())
        setPlatformOrganizationsState({ kind: "error" });
    }
  };

  return (
    <AppShell
      destination={destination}
      onNavigate={setDestination}
      canAdministrate={canAdministrate(profile)}
    >
      <ProtectedSessionProvider onUnauthorized={onUnauthorized}>
        <InvoiceDecisionsProvider key={profile.id}>
          <PolicyMutationsProvider key={profile.id}>
            <WorkspaceProvider
              key={`${session.current.epoch}:${profile.id}`}
              profile={profile}
              groups={
                groupsState.kind === "loaded" ? groupsState.groups : undefined
              }
            >
              <section aria-label="Sesión" className="session-toolbar">
                {!isLoggingOut ? <WorkspaceSummary /> : null}
                <button
                  type="button"
                  onClick={() => void logout()}
                  disabled={isLoggingOut}
                >
                  {isLoggingOut ? "Cerrando sesión..." : "Cerrar sesión"}
                </button>
                {logoutError ? <p role="alert">{logoutError}</p> : null}
              </section>
              {!isLoggingOut ? (
                <>
                  {destination === "Administración" ? (
                    <AdministrationScreen
                      profile={profile}
                      discovery={platformOrganizationsState}
                      controller={administration}
                      onGroups={() => setDestination("Mis grupos")}
                      onRetry={() => void retryAdministrationDiscovery()}
                      onExecute={(intent) =>
                        void administration.execute(
                          intent,
                          refreshAdministration,
                          administrationSessionCurrent,
                          onUnauthorized,
                        )
                      }
                      onRetryRead={(key) =>
                        void administration.retryRead(
                          key,
                          refreshAdministration,
                          administrationSessionCurrent,
                        )
                      }
                    />
                  ) : null}
                  {destination === "Panel principal" ? (
                    <DashboardScreen
                      profile={profile}
                      contextState={groupsState.kind}
                      onNavigate={setDestination}
                      onRetry={() => void reloadGroups()}
                    />
                  ) : null}
                  {destination === "Mi perfil" ? (
                    <ProfileScreen
                      profile={profile}
                      email={email}
                      username={username}
                      isSaving={isSaving}
                      message={message}
                      onEmailChange={setEmail}
                      onUsernameChange={setUsername}
                      onSubmit={saveProfile}
                    />
                  ) : null}
                  {destination === "Organizaciones" ? (
                    <OrganizationsScreen
                      profile={profile}
                      discovery={platformOrganizationsState}
                      contextState={groupsState.kind}
                      onRetry={() => void reloadGroups()}
                    />
                  ) : null}
                  {destination === "Mis grupos" ? (
                    <GroupsScreen
                      profile={profile}
                      state={groupsState}
                      discovery={platformOrganizationsState}
                      pending={isMutatingGroup}
                      blocked={groupOperations.blocked}
                      operations={groupOperations.operations}
                      readRevision={groupReadRevision}
                      sessionEpoch={session.current.epoch}
                      onUnauthorized={onUnauthorized}
                      operation={groupOperation}
                      error={groupError}
                      message={groupMessage}
                      onRetry={() => void reloadGroups()}
                      onMutate={(...args) => void mutateGroup(...args)}
                    />
                  ) : null}
                  {destination === "Recursos" ||
                  destination === "Facturas" ||
                  destination === "Evidencia y lotes" ||
                  destination === "Políticas" ? (
                    groupsState.kind === "loaded" ? (
                      <WorkspaceBoundary>
                        {destination === "Evidencia y lotes" ? (
                          <EvidenceScreen />
                        ) : destination === "Políticas" ? (
                          <PoliciesScreen profile={profile} />
                        ) : destination === "Recursos" ? (
                          <ResourceContext
                            profile={profile}
                            groups={groupsState.groups}
                          />
                        ) : (
                          <InvoiceWorkspace
                            profile={profile}
                            groups={groupsState.groups}
                          />
                        )}
                      </WorkspaceBoundary>
                    ) : groupsState.kind === "error" ? (
                      <>
                        <p role="alert">
                          No fue posible cargar el contexto de trabajo.
                        </p>
                        <button
                          type="button"
                          onClick={() => void reloadGroups()}
                        >
                          Reintentar contexto
                        </button>
                      </>
                    ) : (
                      <p role="status">Cargando contexto de trabajo...</p>
                    )
                  ) : null}
                </>
              ) : (
                <p role="status">Cerrando sesión...</p>
              )}
            </WorkspaceProvider>
          </PolicyMutationsProvider>
        </InvoiceDecisionsProvider>
      </ProtectedSessionProvider>
    </AppShell>
  );
}
