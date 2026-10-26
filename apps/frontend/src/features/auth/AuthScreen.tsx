import { useEffect, useRef, useState, type FormEvent } from "react";

function authErrorMessage(status: number) {
  if (status === 429) {
    return "Demasiados intentos. Espera unos minutos antes de intentar nuevamente.";
  }
  if (status === 403)
    return "No fue posible autorizar el acceso. Recarga la página e intenta nuevamente.";
  if (status === 401 || status === 400) {
    return "Revisa el RUT y la contraseña e intenta nuevamente.";
  }
  return "No fue posible iniciar sesión. Intenta nuevamente más tarde.";
}

export function AuthScreen({ onLogin }: { onLogin: () => void }) {
  const [rut, setRut] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeRequest.current) {
      return;
    }
    setError(undefined);
    if (!rut.trim() || !password) {
      setError("Completa los datos requeridos para continuar.");
      return;
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    try {
      const response = await fetch("/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rut: rut.trim(), password }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      if (response.status !== 200) {
        setPassword("");
        setError(authErrorMessage(response.status));
        return;
      }

      setPassword("");
      // The response user is not a session or an authorization source.
      onLogin();
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
      <h1 id="auth-title">Iniciar sesión</h1>
      <p>Tu sesión no está disponible o expiró.</p>
      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-labelledby="auth-title"
        aria-busy={pending}
      >
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
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            required
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Iniciando sesión..." : "Iniciar sesión"}
        </button>
        {pending ? <p role="status">Iniciando sesión...</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </main>
  );
}
