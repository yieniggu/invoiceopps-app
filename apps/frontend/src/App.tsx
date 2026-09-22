import { useEffect, useState, type FormEvent } from "react";

import { ResourceContext } from "./features/resources/ResourceContext";
import { InvoiceWorkspace } from "./features/invoices/InvoiceWorkspace";

type Profile = {
  id: string;
  name: string;
  rut: string;
  email: string | null;
  username: string | null;
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

export function App() {
  const [state, setState] = useState<ProfileState>({ kind: "loading" });
  const [groupsState, setGroupsState] = useState<GroupsState>({ kind: "idle" });
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [message, setMessage] = useState<string>();
  const [logoutError, setLogoutError] = useState<string>();
  const [groupError, setGroupError] = useState<string>();
  const [isMutatingGroup, setIsMutatingGroup] = useState(false);
  const [showInvoices, setShowInvoices] = useState(false);

  const loadProfile = async () => {
    setState({ kind: "loading" });
    setMessage(undefined);

    try {
      const result = await requestProfile();
      setState(result);
      if (result.kind === "authenticated") {
        setEmail(result.profile.email ?? "");
        setUsername(result.profile.username ?? "");
        if (result.profile.memberships.length > 0) {
          setGroupsState({ kind: "loading" });
          try {
            setGroupsState({ kind: "loaded", ...(await requestGroups()) });
          } catch {
            setGroupsState({ kind: "error" });
          }
        } else {
          setGroupsState({ kind: "loaded", groups: [] });
        }
      } else {
        setGroupsState({ kind: "idle" });
      }
    } catch {
      setState({ kind: "error" });
    }
  };

  const reloadGroups = async () => {
    setGroupError(undefined);
    setGroupsState({ kind: "loading" });
    try {
      setGroupsState({ kind: "loaded", ...(await requestGroups()) });
    } catch {
      setGroupsState({ kind: "error" });
    }
  };

  const mutateGroup = async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ) => {
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

      if (response.status === 401) {
        setState({ kind: "anonymous" });
        setGroupsState({ kind: "idle" });
        return;
      }

      if (!response.ok) {
        throw new Error("Group mutation failed");
      }

      await reloadGroups();
    } catch {
      setGroupError(
        "No fue posible actualizar los grupos. Intenta nuevamente.",
      );
    } finally {
      setIsMutatingGroup(false);
    }
  };

  useEffect(() => {
    void loadProfile();
  }, []);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setMessage(undefined);

    try {
      const response = await fetch("/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, username }),
      });

      if (response.status === 401) {
        setState({ kind: "anonymous" });
        return;
      }

      if (!response.ok) {
        throw new Error("Profile update failed");
      }

      const { profile } = (await response.json()) as { profile: Profile };
      setState({ kind: "authenticated", profile });
      setEmail(profile.email ?? "");
      setUsername(profile.username ?? "");
      setMessage("Perfil actualizado.");
    } catch {
      setMessage("No fue posible actualizar el perfil. Intenta nuevamente.");
    } finally {
      setIsSaving(false);
    }
  };

  const logout = async () => {
    setIsLoggingOut(true);
    setLogoutError(undefined);

    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });

      if (response.status === 401) {
        setState({ kind: "anonymous" });
        return;
      }

      if (!response.ok) {
        throw new Error("Logout request failed");
      }

      setState({ kind: "anonymous" });
    } catch {
      setLogoutError("No fue posible cerrar la sesión. Intenta nuevamente.");
    } finally {
      setIsLoggingOut(false);
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
    return (
      <main className="shell" aria-labelledby="page-title">
        <p className="eyebrow">InvoiceOps</p>
        <h1 id="page-title">Mi perfil</h1>
        <p role="status">Tu sesión no está disponible o expiró.</p>
      </main>
    );
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
        {profile.memberships.length === 0 ? (
          <p>No tienes organizaciones asignadas.</p>
        ) : (
          <ul>
            {profile.memberships.map(({ organization, role }) => (
              <li key={organization.id}>
                {organization.name} <span>({role})</span>
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
        {groupsState.kind === "loaded" && groupsState.groups.length === 0 ? (
          <p>No perteneces a grupos todavía.</p>
        ) : null}
        {groupsState.kind === "loaded" ? (
          <ul>
            {groupsState.groups.map((group) => {
              const role = profile.memberships.find(
                ({ organization }) => organization.id === group.organization.id,
              )?.role;
              const isAdmin = role === "ADMIN";
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
        {profile.memberships
          .filter(({ role }) => role === "ADMIN")
          .map(({ organization }) => (
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
