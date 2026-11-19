import { useRef, useState, type FormEvent } from "react";

import { ThemeToggle } from "../../../components/ThemeToggle";
import { PasswordInput } from "../../../components/PasswordInput";
import { RutField } from "../../../components/RutField";
import { isValidRut } from "../../../lib/rut";
import { isApiError, isNetworkFailure } from "../api/apiError";
import { useLoginMutation } from "../hooks/useAuthMutations";
import type { SessionEnd } from "../session/sessionStore";

/** Contract kind of a failed login (docs/rpa-selector-contract.md §2.2). */
type AuthErrorKind =
  "credentials" | "forbidden" | "rate-limited" | "network" | "unknown";

interface AuthFailure {
  kind: AuthErrorKind;
  message: string;
  /** HTTP status, or empty when no response arrived. */
  status: string;
  /** API error code, `NETWORK` without a response, empty when none was sent. */
  code: string;
}

function describeAuthFailure(error: unknown): AuthFailure {
  if (!isApiError(error) && !isNetworkFailure(error))
    return {
      kind: "unknown",
      message: "No fue posible iniciar sesión. Intenta nuevamente más tarde.",
      status: "",
      code: "UNKNOWN",
    };
  if (!isApiError(error))
    return {
      kind: "network",
      message:
        "No fue posible conectar. Revisa tu conexión e intenta nuevamente.",
      status: "",
      code: "NETWORK",
    };
  const reply = { status: String(error.status), code: error.code ?? "" };
  if (error.status === 429)
    return {
      kind: "rate-limited",
      message:
        "Demasiados intentos. Espera unos minutos antes de intentar nuevamente.",
      ...reply,
    };
  if (error.status === 403)
    return {
      kind: "forbidden",
      message:
        "No fue posible autorizar el acceso. Recarga la página e intenta nuevamente.",
      ...reply,
    };
  if (error.status === 401 || error.status === 400)
    return {
      kind: "credentials",
      message: "Revisa el RUT y la contraseña e intenta nuevamente.",
      ...reply,
    };
  return {
    kind: "unknown",
    message: "No fue posible iniciar sesión. Intenta nuevamente más tarde.",
    ...reply,
  };
}

/** Why the login screen is shown, for automation (`data-auth-reason`). */
const authReason = (endedBy: SessionEnd | null) =>
  endedBy === "logout"
    ? "logout"
    : endedBy === "unauthorized"
      ? "expired"
      : "none";

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
  const failure = login.isError ? describeAuthFailure(login.error) : undefined;
  const formState = pending
    ? "pending"
    : login.isSuccess
      ? "success"
      : failure
        ? "error"
        : "idle";

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
    <main
      className="shell"
      data-screen="auth"
      data-auth-reason={authReason(endedBy)}
      aria-labelledby="auth-title"
    >
      <div className="shell-toolbar">
        <ThemeToggle />
      </div>
      <p className="eyebrow">InvoiceOps</p>
      <h1 id="auth-title">Iniciar sesión</h1>
      <p>
        {endedBy === "logout"
          ? "Ingresa con tu RUT y contraseña."
          : "Tu sesión no está disponible o expiró."}
      </p>
      <form
        id="login-form"
        data-testid="login-form"
        data-state={formState}
        onSubmit={submit}
        noValidate
        aria-labelledby="auth-title"
        aria-busy={pending}
      >
        <RutField
          id="login-rut"
          name="rut"
          label="RUT"
          autoComplete="username"
          value={rut}
          onChange={setRut}
          disabled={pending}
          submitted={submitted}
          inputRef={rutInput}
          required
        />
        <PasswordInput
          id="login-password"
          name="password"
          label="Contraseña"
          inputRef={passwordInput}
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
        <p
          id="login-password-error"
          data-testid="login-password-error"
          data-field="password"
          className="field-error"
          aria-live="polite"
        >
          {passwordMissing ? "Ingresa tu contraseña" : ""}
        </p>
        <button
          id="login-submit"
          data-testid="login-submit"
          type="submit"
          disabled={pending}
        >
          {pending ? "Iniciando sesión..." : "Iniciar sesión"}
        </button>
        {pending ? <p role="status">Iniciando sesión...</p> : null}
        {failure ? (
          <p
            id="login-error"
            data-testid="login-error"
            data-error-kind={failure.kind}
            data-error-status={failure.status}
            data-error-code={failure.code}
            role="alert"
          >
            {failure.message}
          </p>
        ) : null}
      </form>
    </main>
  );
}
