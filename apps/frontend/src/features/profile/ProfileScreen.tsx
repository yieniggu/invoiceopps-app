import { useState, type FormEvent } from "react";
import { fromApiRut } from "../../lib/rut";
import type { Profile } from "../auth/types";
import { usePendingContact, useUpdateProfile } from "./hooks/useUpdateProfile";

export type { Profile };

export function roleLabel(role: string) {
  return role === "ADMIN"
    ? "Administrador"
    : role === "USER"
      ? "Usuario"
      : "Rol no disponible";
}

export function ProfileScreen({ profile }: { profile: Profile }) {
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
      ? "No fue posible actualizar el perfil. Intenta nuevamente."
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
    <div className="screen-grid">
      <section aria-labelledby="identity-title">
        <h2 id="identity-title">Identidad</h2>
        <p>
          Datos de identificación registrados. No se editan desde esta pantalla.
        </p>
        <dl>
          <div>
            <dt>Nombre</dt>
            <dd>{profile.name}</dd>
          </div>
          <div>
            <dt>RUT</dt>
            <dd>{fromApiRut(profile.rut)}</dd>
          </div>
        </dl>
        {profile.isPlatformAdministrator ? (
          <p className="role-badge">Administrador de plataforma</p>
        ) : null}
      </section>
      <form onSubmit={onSubmit} aria-labelledby="contact-title">
        <h2 id="contact-title">Datos de contacto</h2>
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
        <button type="submit" disabled={isSaving}>
          {isSaving ? "Guardando cambios..." : "Guardar cambios"}
        </button>
        {isSaving ? (
          <p role="status">Guardando cambios del perfil...</p>
        ) : message ? (
          <p role={message.startsWith("No fue") ? "alert" : "status"}>
            {message}
          </p>
        ) : null}
      </form>
      <section
        aria-labelledby="profile-memberships-title"
        className="screen-wide"
      >
        <h2 id="profile-memberships-title">Membresías del perfil</h2>
        {profile.memberships.length === 0 ? (
          <p>No tienes organizaciones asignadas.</p>
        ) : (
          <ul className="membership-list">
            {profile.memberships.map(({ organization, role }) => (
              <li key={organization.id}>
                <strong>{organization.name}</strong>
                <span className="role-badge">{roleLabel(role)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
