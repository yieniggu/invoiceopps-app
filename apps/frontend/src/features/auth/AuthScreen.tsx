import { useEffect, useRef, useState, type FormEvent } from "react";

type AuthMode = "login" | "signup";

function authErrorMessage(status: number, mode: AuthMode) {
  if (status === 429) {
    return "Demasiados intentos. Espera unos minutos antes de intentar nuevamente.";
  }
  if (status === 403) {
    return mode === "signup"
      ? "El registro no está autorizado. Contacta a la administración para revisar tu acceso."
      : "No fue posible autorizar el acceso. Recarga la página e intenta nuevamente.";
  }
  if (mode === "signup" && status === 409) {
    return "No fue posible crear la cuenta. Revisa tus datos o intenta iniciar sesión.";
  }
  if (mode === "signup" && status === 400) {
    return "Revisa los datos del registro: nombre, RUT y contraseña de al menos 12 caracteres.";
  }
  if (status === 401 || status === 400) {
    return "Revisa el RUT y la contraseña e intenta nuevamente.";
  }
  return mode === "signup"
    ? "No fue posible completar el registro. Intenta nuevamente más tarde."
    : "No fue posible iniciar sesión. Intenta nuevamente más tarde.";
}

export function AuthScreen({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [name, setName] = useState("");
  const [rut, setRut] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<string>();
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const switchMode = () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setMode(mode === "login" ? "signup" : "login");
    setPassword("");
    setPending(false);
    setError(undefined);
    setConfirmation(undefined);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeRequest.current) {
      return;
    }
    setError(undefined);
    setConfirmation(undefined);
    if (!rut.trim() || !password || (mode === "signup" && !name.trim())) {
      setError("Completa los datos requeridos para continuar.");
      return;
    }
    if (mode === "signup" && password.length < 12) {
      setError("La contraseña debe tener al menos 12 caracteres.");
      return;
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    try {
      const response = await fetch(`/auth/${mode}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "signup"
            ? { name: name.trim(), rut: rut.trim(), password }
            : { rut: rut.trim(), password },
        ),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      if (response.status !== (mode === "signup" ? 201 : 200)) {
        setPassword("");
        setError(authErrorMessage(response.status, mode));
        return;
      }

      setPassword("");
      if (mode === "signup") {
        setMode("login");
        setName("");
        setConfirmation(
          "Cuenta creada. Inicia sesión con tu RUT y contraseña.",
        );
      } else {
        // The response user is not a session or an authorization source.
        onLogin();
      }
    } catch {
      if (!controller.signal.aborted) {
        setPassword("");
        setError(
          "No fue posible conectar. Revisa tu conexión e intenta nuevamente.",
        );
      }
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        if (!controller.signal.aborted) {
          setPending(false);
        }
      }
    }
  };

  return (
    <main className="shell" aria-labelledby="auth-title">
      <p className="eyebrow">InvoiceOps</p>
      <h1 id="auth-title">
        {mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
      </h1>
      <p>Tu sesión no está disponible o expiró.</p>
      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-labelledby="auth-title"
        aria-busy={pending}
      >
        {mode === "signup" ? (
          <label>
            Nombre
            <input
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
              required
            />
          </label>
        ) : null}
        <label>
          RUT
          <input
            autoComplete="username"
            value={rut}
            onChange={(event) => setRut(event.target.value)}
            disabled={pending}
            required
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            autoComplete={
              mode === "signup" ? "new-password" : "current-password"
            }
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            required
            aria-describedby={mode === "signup" ? "password-help" : undefined}
          />
        </label>
        {mode === "signup" ? (
          <p id="password-help">Usa al menos 12 caracteres.</p>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending
            ? mode === "login"
              ? "Iniciando sesión..."
              : "Creando cuenta..."
            : mode === "login"
              ? "Iniciar sesión"
              : "Crear cuenta"}
        </button>
        {pending ? (
          <p role="status">
            {mode === "login" ? "Iniciando sesión..." : "Creando cuenta..."}
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {confirmation ? <p role="status">{confirmation}</p> : null}
      </form>
      <button type="button" onClick={switchMode}>
        {mode === "login" ? "Crear cuenta" : "Iniciar sesión"}
      </button>
    </main>
  );
}
