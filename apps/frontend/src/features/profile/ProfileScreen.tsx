import type { FormEvent } from "react";

export type Profile = {
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

export function roleLabel(role: string) {
  return role === "ADMIN"
    ? "Administrador"
    : role === "STUDENT"
      ? "Estudiante"
      : "Rol no disponible";
}

export function ProfileScreen({
  profile,
  email,
  username,
  isSaving,
  message,
  onEmailChange,
  onUsernameChange,
  onSubmit,
}: {
  profile: Profile;
  email: string;
  username: string;
  isSaving: boolean;
  message?: string;
  onEmailChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
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
            <dd>{profile.rut}</dd>
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
            onChange={(event) => onEmailChange(event.target.value)}
          />
        </label>
        <label>
          Nombre de usuario
          <input
            autoComplete="username"
            value={username}
            disabled={isSaving}
            onChange={(event) => onUsernameChange(event.target.value)}
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
