import { useEffect, useRef, useState, type FormEvent } from "react";

import { AuthScreen } from "./features/auth/AuthScreen";
import { ResourceContext } from "./features/resources/ResourceContext";
import { InvoiceWorkspace } from "./features/invoices/InvoiceWorkspace";

type Profile = {
  id: string;
  name: string;
  rut: string;
  email: string | null;
  username: string | null;
  isPlatformAdministrator: boolean;
  memberships: Array<{
    organization: { id: string; name: string; slug: string };
    role: string;
  }>;
};

type ProfileState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "error" }
  | { kind: "authenticated"; profile: Profile };

type Group = {
  id: string;
  name: string;
  description: string | null;
  organization: { id: string; name: string };
  members: Array<{ id: string; name: string; rut: string }>;
};

type GroupsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; groups: Group[] };

type PlatformOrganizationsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; organizations: PlatformOrganization[] };

type PlatformOrganization = {
  id: string;
  name: string;
  groups: Group[];
};

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

async function requestGroups() {
  const response = await fetch("/groups", { credentials: "same-origin" });

  if (!response.ok) {
    throw new Error("Groups request failed");
  }

  return (await response.json()) as { groups: Group[] };
}

async function requestPlatformOrganizations() {
  const response = await fetch("/platform/organizations", {
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error("Platform organization request failed");
  }

  return (await response.json()) as {
    organizations: PlatformOrganization[];
  };
}

export function App() {
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
  const [showInvoices, setShowInvoices] = useState(false);
  // Every App-owned operation belongs to one session epoch, including logout.
  // Invalidating UI work does not roll back requests already received by the server.
  const session = useRef({ epoch: 0, active: false });

  const beginSessionEpoch = (active: boolean) => {
    session.current = { epoch: session.current.epoch + 1, active };
    setIsSaving(false);
    setIsLoggingOut(false);
    setIsMutatingGroup(false);
    setMessage(undefined);
    setLogoutError(undefined);
    setGroupError(undefined);
    return session.current.epoch;
  };

  const endSession = () => {
    beginSessionEpoch(false);
    setState({ kind: "anonymous" });
    setGroupsState({ kind: "idle" });
    setPlatformOrganizationsState({ kind: "idle" });
    setEmail("");
    setUsername("");
    setShowInvoices(false);
  };

  const loadProfile = async () => {
    const epoch = beginSessionEpoch(true);
    const isCurrent = () => session.current.epoch === epoch;
    setState({ kind: "loading" });
    setGroupsState({ kind: "idle" });
    setPlatformOrganizationsState({ kind: "idle" });
    setShowInvoices(false);

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
          } catch {
            if (!isCurrent()) return;
            setPlatformOrganizationsState({ kind: "error" });
          }

          if (result.profile.memberships.length > 0) {
            setGroupsState({ kind: "loading" });
            try {
              const groups = await requestGroups();
              if (!isCurrent()) return;
              setGroupsState({ kind: "loaded", ...groups });
            } catch {
              if (!isCurrent()) return;
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
          } catch {
            if (!isCurrent()) return;
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
    const isCurrent = () => session.current.epoch === epoch;
    if (
      !isCurrent() ||
      !session.current.active ||
      state.kind !== "authenticated"
    ) {
      return;
    }

    setGroupError(undefined);
    setGroupsState({ kind: "loading" });
    try {
      if (state.profile.isPlatformAdministrator) {
        setPlatformOrganizationsState({ kind: "loading" });
        try {
          const discovery = await requestPlatformOrganizations();
          if (!isCurrent()) return;
          setPlatformOrganizationsState({ kind: "loaded", ...discovery });
        } catch {
          if (!isCurrent()) return;
          setPlatformOrganizationsState({ kind: "error" });
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
    } catch {
      if (!isCurrent()) return;
      setGroupsState({ kind: "error" });
    }
  };

  const mutateGroup = async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ) => {
    if (!session.current.active || state.kind !== "authenticated") return;
    const epoch = session.current.epoch;
    const isCurrent = () => session.current.epoch === epoch;
    setIsMutatingGroup(true);
    setGroupError(undefined);
    try {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });

      if (!isCurrent()) return;
      if (response.status === 401) {
        endSession();
        return;
      }

      if (!response.ok) {
        throw new Error("Group mutation failed");
      }

      await reloadGroups(epoch);
    } catch {
      if (!isCurrent()) return;
      setGroupError(
        "No fue posible actualizar los grupos. Intenta nuevamente.",
      );
    } finally {
      if (isCurrent()) setIsMutatingGroup(false);
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
    if (!session.current.active || state.kind !== "authenticated") return;
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
      setState({ kind: "authenticated", profile });
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
  const displayedGroups =
    profile.isPlatformAdministrator &&
    platformOrganizationsState.kind === "loaded"
      ? (platformOrganizationsState.organizations ?? []).flatMap(
          (organization) => organization.groups,
        )
      : groupsState.kind === "loaded"
        ? groupsState.groups
        : [];

  return (
    <main className="shell" aria-labelledby="page-title">
      <p className="eyebrow">InvoiceOps</p>
      <h1 id="page-title">Mi perfil</h1>

      <section aria-labelledby="identity-title">
        <h2 id="identity-title">Identidad</h2>
        <dl>
          <div>
            <dt>Nombre</dt>
            <dd>{profile.name}</dd>
          </div>
          <div>
            <dt>RUT</dt>
            <dd>{profile.rut}</dd>
          </div>
        </dl>
        {profile.isPlatformAdministrator ? (
          <p role="status">Administrador de plataforma</p>
        ) : null}
      </section>

      <form onSubmit={saveProfile} aria-labelledby="contact-title">
        <h2 id="contact-title">Datos de contacto</h2>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <button type="submit" disabled={isSaving}>
          {isSaving ? "Guardando cambios..." : "Guardar cambios"}
        </button>
        {message ? (
          <p role={message.startsWith("No fue") ? "alert" : "status"}>
            {message}
          </p>
        ) : null}
      </form>

      <section aria-label="Sesión">
        <button
          type="button"
          onClick={() => void logout()}
          disabled={isLoggingOut}
        >
          {isLoggingOut ? "Cerrando sesión..." : "Cerrar sesión"}
        </button>
        {logoutError ? <p role="alert">{logoutError}</p> : null}
      </section>

      <section aria-labelledby="memberships-title">
        <h2 id="memberships-title">Organizaciones</h2>
        {profile.isPlatformAdministrator &&
        platformOrganizationsState.kind === "loading" ? (
          <p role="status">Cargando organizaciones administrables...</p>
        ) : null}
        {profile.isPlatformAdministrator &&
        platformOrganizationsState.kind === "error" ? (
          <>
            <p role="alert">No fue posible cargar las organizaciones.</p>
            <button type="button" onClick={() => void reloadGroups()}>
              Reintentar organizaciones
            </button>
          </>
        ) : null}
        {profile.isPlatformAdministrator &&
        platformOrganizationsState.kind === "loaded" ? (
          (platformOrganizationsState.organizations ?? []).length === 0 ? (
            <p>No hay organizaciones disponibles.</p>
          ) : (
            <ul>
              {(platformOrganizationsState.organizations ?? []).map(
                (organization) => (
                  <li key={organization.id}>{organization.name}</li>
                ),
              )}
            </ul>
          )
        ) : profile.memberships.length === 0 ? (
          <p>No tienes organizaciones asignadas.</p>
        ) : (
          <ul>
            {profile.memberships.map(({ organization, role }) => (
              <li key={organization.id}>
                {organization.name}{" "}
                <span>
                  (
                  {role === "STUDENT"
                    ? "Estudiante"
                    : role === "ADMIN"
                      ? "Administrador"
                      : "Rol no disponible"}
                  )
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="groups-title">
        <h2 id="groups-title">Mis grupos</h2>
        {groupsState.kind === "loading" ? (
          <p role="status">Cargando grupos...</p>
        ) : null}
        {groupsState.kind === "error" ? (
          <>
            <p role="alert">No fue posible cargar los grupos.</p>
            <button type="button" onClick={() => void reloadGroups()}>
              Reintentar grupos
            </button>
          </>
        ) : null}
        {groupsState.kind === "loaded" && displayedGroups.length === 0 ? (
          <p>
            {profile.isPlatformAdministrator
              ? "No hay grupos en las organizaciones administrables."
              : "No perteneces a grupos todavía."}
          </p>
        ) : null}
        {groupsState.kind === "loaded" ? (
          <ul>
            {displayedGroups.map((group) => {
              const role = profile.memberships.find(
                ({ organization }) => organization.id === group.organization.id,
              )?.role;
              const isAdmin =
                role === "ADMIN" || profile.isPlatformAdministrator;
              const path = `/organizations/${group.organization.id}/groups/${group.id}`;

              return (
                <li key={group.id}>
                  <h3>{group.name}</h3>
                  <p>{group.organization.name}</p>
                  {group.description ? <p>{group.description}</p> : null}
                  <h4>Integrantes</h4>
                  {group.members.length === 0 ? (
                    <p>Este grupo no tiene integrantes.</p>
                  ) : (
                    <ul>
                      {group.members.map((member) => (
                        <li key={member.id}>
                          {member.name} ({member.rut})
                          {isAdmin ? (
                            <button
                              type="button"
                              disabled={isMutatingGroup}
                              onClick={() =>
                                void mutateGroup(
                                  `${path}/members/${member.id}`,
                                  "DELETE",
                                )
                              }
                            >
                              Quitar a {member.name}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  {isAdmin ? (
                    <>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          void mutateGroup(path, "PATCH", {
                            name: form.get("name"),
                            description: form.get("description"),
                          });
                        }}
                      >
                        <label>
                          Editar nombre de {group.name}
                          <input
                            name="name"
                            defaultValue={group.name}
                            required
                          />
                        </label>
                        <label>
                          Editar descripción de {group.name}
                          <input
                            name="description"
                            defaultValue={group.description ?? ""}
                          />
                        </label>
                        <button type="submit" disabled={isMutatingGroup}>
                          Guardar grupo
                        </button>
                      </form>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          void mutateGroup(`${path}/members`, "POST", {
                            userId: form.get("userId"),
                          });
                        }}
                      >
                        <label>
                          ID de integrante para {group.name}
                          <input name="userId" required />
                        </label>
                        <button type="submit" disabled={isMutatingGroup}>
                          Agregar integrante
                        </button>
                      </form>
                      <button
                        type="button"
                        disabled={isMutatingGroup}
                        onClick={() => void mutateGroup(path, "DELETE")}
                      >
                        Eliminar grupo {group.name}
                      </button>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {(profile.isPlatformAdministrator &&
        platformOrganizationsState.kind === "loaded"
          ? (platformOrganizationsState.organizations ?? [])
          : profile.memberships
              .filter(({ role }) => role === "ADMIN")
              .map(({ organization }) => organization)
        ).map((organization) => (
          <form
            key={organization.id}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void mutateGroup(
                `/organizations/${organization.id}/groups`,
                "POST",
                {
                  name: form.get("name"),
                },
              );
            }}
          >
            <label>
              Nuevo grupo
              <input name="name" required />
            </label>
            <button type="submit" disabled={isMutatingGroup}>
              Crear grupo en {organization.name}
            </button>
          </form>
        ))}
        {groupError ? <p role="alert">{groupError}</p> : null}
      </section>

      {groupsState.kind === "loaded" ? (
        <>
          <ResourceContext profile={profile} groups={groupsState.groups} />
          <section aria-labelledby="invoices-navigation-title">
            <h2 id="invoices-navigation-title">Facturas</h2>
            <p>
              Consulta y decide las facturas del contexto de trabajo elegido.
            </p>
            <button
              type="button"
              onClick={() => setShowInvoices((value) => !value)}
            >
              {showInvoices ? "Ocultar facturas" : "Ver facturas"}
            </button>
          </section>
          {showInvoices ? (
            <InvoiceWorkspace profile={profile} groups={groupsState.groups} />
          ) : null}
        </>
      ) : null}
    </main>
  );
}
