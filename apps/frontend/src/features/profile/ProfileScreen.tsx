import { PendingButton } from "../../components/PendingButton";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { Toast } from "../../components/Toast";
import { fromApiRut } from "../../lib/rut";
import { isApiError } from "../auth/api/apiError";
import { PasswordChangeForm } from "../auth/components/PasswordChangeForm";
import type { Profile } from "../auth/types";
import { paths, type RouteNotice } from "../navigation/paths";
import { useRouteNotice } from "../navigation/useRouteNotice";
import { memberRoleLabel } from "../orgs/types/roles";
import { usePendingContact, useUpdateProfile } from "./hooks/useUpdateProfile";

export type { Profile };

export function roleLabel(role: string) {
  return role === "ADMIN" || role === "USER"
    ? memberRoleLabel(role)
    : "Rol no disponible";
}

const SAVE_FAILED = "No fue posible actualizar el perfil. Intenta nuevamente.";

/** Spanish text for a refused save: what the server found wrong, if known. */
export function describeSaveError(error: unknown) {
  if (!isApiError(error)) return SAVE_FAILED;
  if (error.status === 409 && error.code === "USER_CONFLICT")
    return "Ese correo electrónico o nombre de usuario ya lo usa otra persona.";
  if (error.status === 400 && error.fields) {
    if ("email" in error.fields)
      return "El correo electrónico no es válido (máximo 254 caracteres, sin caracteres de control).";
    if ("username" in error.fields)
      return "El nombre de usuario no es válido (máximo 64 caracteres, sin caracteres de control).";
  }
  return SAVE_FAILED;
}

const PASSWORD_CHANGED = "Contraseña actualizada.";

export function ProfileScreen({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const notice = useRouteNotice();
  const update = useUpdateProfile(profile.id);
  // A save started before leaving this screen is still the latest intent.
  const inFlight = usePendingContact();
  // Form drafts are local state; the saved profile itself lives in Query.
  const [email, setEmail] = useState(inFlight?.email ?? profile.email ?? "");
  const [username, setUsername] = useState(
    inFlight?.username ?? profile.username ?? "",
  );
  const isSaving = update.isPending || inFlight !== undefined;
  const message = update.isSuccess
    ? "Perfil actualizado."
    : update.isError
      ? describeSaveError(update.error)
      : undefined;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;
    update.mutate(
      { email, username },
      {
        onSuccess: (saved) => {
          setEmail(saved.email ?? "");
          setUsername(saved.username ?? "");
        },
      },
    );
  };

  return (
    <div className="screen-stack">
      <PageHeader
        title="Mi perfil"
        description={
          <>
            <span className="profile-identity-name">{profile.name}</span>
            {" · "}
            <span>{fromApiRut(profile.rut)}</span>
          </>
        }
        titleAddon={
          profile.isPlatformAdministrator ? (
            <span className="role-badge">Administrador de plataforma</span>
          ) : undefined
        }
      />
      <Toast message={notice.message} noticeId={notice.id} />
      <div className="profile-layout">
        <div className="profile-main">
          <form onSubmit={onSubmit} aria-labelledby="contact-title">
            <h2 id="contact-title">Cuenta</h2>
            <label>
              Correo electrónico
              <input
                type="email"
                autoComplete="email"
                value={email}
                disabled={isSaving}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Nombre de usuario
              <input
                autoComplete="username"
                value={username}
                disabled={isSaving}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <PendingButton
              type="submit"
              disabled={isSaving}
              pending={isSaving}
              announce={{ pending: "Guardando perfil" }}
            >
              Guardar cambios
            </PendingButton>
            {message ? (
              <p role={update.isError ? "alert" : "status"}>{message}</p>
            ) : null}
          </form>
          <section aria-labelledby="profile-password-title">
            <h2 id="profile-password-title">Contraseña</h2>
            <PasswordChangeForm
              currentLabel="Contraseña actual"
              emptyCurrentMessage="Ingresa tu contraseña actual."
              invalidCurrentMessage="La contraseña actual no es correcta."
              errorId="profile-password-error"
              describedBy="profile-password-consequence"
              // The rotation remounts this screen: the notice travels in the
              // navigation state, which the new instance reads.
              onSuccess={() =>
                navigate(paths.profile, {
                  replace: true,
                  state: { notice: PASSWORD_CHANGED } satisfies RouteNotice,
                })
              }
              footer={
                <p className="muted" id="profile-password-consequence">
                  Cierra tus otras sesiones y revoca tus tokens de API.
                </p>
              }
            />
          </section>
        </div>
        <section
          aria-labelledby="profile-memberships-title"
          className="profile-side"
        >
          <h2 id="profile-memberships-title">Organizaciones</h2>
          {profile.memberships.length === 0 ? (
            <p>No tienes organizaciones asignadas.</p>
          ) : (
            <ul className="org-list">
              {profile.memberships.map(({ organization, role, groups }) => (
                <li key={organization.id}>
                  <div className="org-row">
                    <strong>{organization.name}</strong>
                    <span className="role-badge">{roleLabel(role)}</span>
                  </div>
                  {groups.length === 0 ? (
                    <p className="muted">Sin grupos</p>
                  ) : (
                    <ul className="chip-list" aria-label="Grupos">
                      {groups.map(({ group }) => (
                        <li key={group.id}>{group.name}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
