import { LogOut } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { PasswordInput } from "../../../components/PasswordInput";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { isApiError } from "../api/apiError";
import { useChangePasswordMutation } from "../hooks/useAuthMutations";
import { useLogoutMutation } from "../hooks/useAuthMutations";

type PasswordField = "currentPassword" | "newPassword";

interface PasswordError {
  /** Field the message is about; null for errors that belong to no field. */
  field: PasswordField | null;
  text: string;
  /** Changes on every failure so the field is focused again each time. */
  nonce: number;
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const PASSWORD_ERROR_ID = "password-change-error";
const NEW_PASSWORD_LENGTH_MESSAGE = `La contraseña nueva debe tener entre ${MIN_PASSWORD_LENGTH} y ${MAX_PASSWORD_LENGTH} caracteres.`;

function serverFailure(error: unknown): Omit<PasswordError, "nonce"> {
  if (!isApiError(error)) {
    return {
      field: null,
      text: "No fue posible conectar con el servidor. Revisa tu conexión e intenta nuevamente.",
    };
  }
  if (error.status === 400 && error.code === "PASSWORD_REUSE") {
    return {
      field: "newPassword",
      text: "La nueva contraseña debe ser distinta de la actual.",
    };
  }
  if (
    error.status === 400 &&
    error.code === "VALIDATION_ERROR" &&
    error.fields &&
    "newPassword" in error.fields
  ) {
    return { field: "newPassword", text: NEW_PASSWORD_LENGTH_MESSAGE };
  }
  return {
    field: null,
    text: "No fue posible cambiar la contraseña. Revisa los datos e intenta nuevamente.",
  };
}

/** The only screen a person with a pending temporary password can use. */
export function ChangePasswordScreen() {
  const change = useChangePasswordMutation();
  const logout = useLogoutMutation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [passwordError, setPasswordError] = useState<PasswordError>();
  const submitting = useRef(false);
  const fields = {
    currentPassword: useRef<HTMLInputElement>(null),
    newPassword: useRef<HTMLInputElement>(null),
  };
  const pending = change.isPending;

  // Moves focus to the field named by the latest error (DOM synchronisation).
  useEffect(() => {
    if (passwordError?.field) fields[passwordError.field].current?.focus();
  }, [passwordError]);

  const fail = (failure: Omit<PasswordError, "nonce">) =>
    setPasswordError((previous) => ({
      ...failure,
      nonce: (previous?.nonce ?? 0) + 1,
    }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    setPasswordError(undefined);
    // Own validation (the form is noValidate): Spanish text, focus and ARIA
    // instead of the browser's native tooltip.
    if (!current) {
      fail({
        field: "currentPassword",
        text: "Ingresa tu contraseña temporal.",
      });
      return;
    }
    if (
      next.length < MIN_PASSWORD_LENGTH ||
      next.length > MAX_PASSWORD_LENGTH
    ) {
      fail({ field: "newPassword", text: NEW_PASSWORD_LENGTH_MESSAGE });
      return;
    }

    submitting.current = true;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onError: (error) => fail(serverFailure(error)),
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  return (
    <main className="shell" aria-labelledby="password-change-title">
      <div className="shell-toolbar">
        <ThemeToggle />
      </div>
      <p className="eyebrow">InvoiceOps</p>
      <h1 id="password-change-title">Cambia tu contraseña temporal</h1>
      <p>
        Debes establecer una contraseña nueva antes de acceder al resto de la
        aplicación.
      </p>
      <form noValidate aria-busy={pending} onSubmit={submit}>
        <PasswordInput
          label="Contraseña temporal"
          inputRef={fields.currentPassword}
          name="currentPassword"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          required
          aria-invalid={passwordError?.field === "currentPassword"}
          aria-describedby={
            passwordError?.field === "currentPassword"
              ? PASSWORD_ERROR_ID
              : undefined
          }
        />
        <PasswordInput
          label="Contraseña nueva"
          inputRef={fields.newPassword}
          name="newPassword"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          required
          aria-invalid={passwordError?.field === "newPassword"}
          aria-describedby={
            passwordError?.field === "newPassword"
              ? PASSWORD_ERROR_ID
              : undefined
          }
        />
        <button type="submit" disabled={pending}>
          {pending ? "Cambiando contraseña..." : "Cambiar contraseña"}
        </button>
      </form>
      {passwordError ? (
        <p role="alert" id={PASSWORD_ERROR_ID}>
          {passwordError.text}
        </p>
      ) : null}
      {logout.isError ? (
        <p role="alert">No fue posible cerrar la sesión. Intenta nuevamente.</p>
      ) : null}
      <button
        type="button"
        className="button-with-icon"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        <LogOut aria-hidden="true" focusable="false" size={18} />
        Salir
      </button>
    </main>
  );
}
