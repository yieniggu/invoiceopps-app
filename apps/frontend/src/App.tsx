import { useEffect, useState, type FormEvent } from "react";

type Profile = {
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

export function App() {
  const [state, setState] = useState<ProfileState>({ kind: "loading" });
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string>();

  const loadProfile = async () => {
    setState({ kind: "loading" });
    setMessage(undefined);

    try {
      const result = await requestProfile();
      setState(result);
      if (result.kind === "authenticated") {
        setEmail(result.profile.email ?? "");
        setUsername(result.profile.username ?? "");
      }
    } catch {
      setState({ kind: "error" });
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
    </main>
  );
}
