import { useRef, useState, type FormEvent } from "react";

import { RutField } from "../../../components/RutField";
import { isValidRut } from "../../../lib/rut";
import { isApiError } from "../api/apiError";
import { useLoginMutation } from "../hooks/useAuthMutations";
import type { SessionEnd } from "../session/sessionStore";

function authErrorMessage(error: unknown) {
  if (!isApiError(error)) {
    return "No fue posible conectar. Revisa tu conexión e intenta nuevamente.";
  }
  if (error.status === 429) {
    return "Demasiados intentos. Espera unos minutos antes de intentar nuevamente.";
  }
  if (error.status === 403)
    return "No fue posible autorizar el acceso. Recarga la página e intenta nuevamente.";
  if (error.status === 401 || error.status === 400) {
    return "Revisa el RUT y la contraseña e intenta nuevamente.";
  }
  return "No fue posible iniciar sesión. Intenta nuevamente más tarde.";
}

export function AuthScreen({
  onLogin,
  endedBy = null,
}: {
  onLogin: () => void;
  /** Only a 401 explains itself; a voluntary logout needs no apology. */
  endedBy?: SessionEnd | null;
}) {
  const login = useLoginMutation();
  const [rut, setRut] = useState("");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [passwordMissing, setPasswordMissing] = useState(false);
  const submitting = useRef(false);
  const rutInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const pending = login.isPending;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    // Every field reports its own problem; nothing generic is added on top.
    setSubmitted(true);
    setPasswordMissing(!password);
    if (!isValidRut(rut)) {
      rutInput.current?.focus();
      return;
    }
    if (!password) {
      passwordInput.current?.focus();
      return;
    }

    submitting.current = true;
    // The values are captured here, before the request starts.
    login.mutate(
      { rut, password },
      {
        onSuccess: () => {
          setPassword("");
          // The response user is not a session or an authorization source.
          onLogin();
        },
        onError: () => setPassword(""),
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  return (
    <main className="shell" aria-labelledby="auth-title">
      <p className="eyebrow">InvoiceOps</p>
      <h1 id="auth-title">Iniciar sesión</h1>
      <p>
        {endedBy === "logout"
          ? "Ingresa con tu RUT y contraseña."
          : "Tu sesión no está disponible o expiró."}
      </p>
      <form
        onSubmit={submit}
        noValidate
        aria-labelledby="auth-title"
        aria-busy={pending}
      >
        <RutField
          label="RUT"
          autoComplete="username"
          value={rut}
          onChange={setRut}
          disabled={pending}
          submitted={submitted}
          inputRef={rutInput}
          required
        />
        <label>
          Contraseña
          <input
            ref={passwordInput}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordMissing(false);
            }}
            disabled={pending}
            required
            aria-invalid={passwordMissing}
            aria-describedby="login-password-error"
          />
        </label>
        <p id="login-password-error" className="field-error" aria-live="polite">
          {passwordMissing ? "Ingresa tu contraseña" : ""}
        </p>
        <button type="submit" disabled={pending}>
          {pending ? "Iniciando sesión..." : "Iniciar sesión"}
        </button>
        {pending ? <p role="status">Iniciando sesión...</p> : null}
        {login.isError ? (
          <p role="alert">{authErrorMessage(login.error)}</p>
        ) : null}
      </form>
    </main>
  );
}
