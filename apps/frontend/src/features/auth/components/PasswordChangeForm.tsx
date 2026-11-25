import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { PasswordInput } from "../../../components/PasswordInput";
import { PendingButton } from "../../../components/PendingButton";
import { describeWait, isApiError } from "../api/apiError";
import { useChangePasswordMutation } from "../hooks/useAuthMutations";

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
const NEW_PASSWORD_LENGTH_MESSAGE = `La contraseña nueva debe tener entre ${MIN_PASSWORD_LENGTH} y ${MAX_PASSWORD_LENGTH} caracteres.`;

function serverFailure(
  error: unknown,
  invalidCurrentMessage: string,
): Omit<PasswordError, "nonce"> {
  if (!isApiError(error)) {
    return {
      field: null,
      text: "No fue posible conectar con el servidor. Revisa tu conexión e intenta nuevamente.",
    };
  }
  if (error.status === 400 && error.code === "INVALID_CURRENT_PASSWORD") {
    return { field: "currentPassword", text: invalidCurrentMessage };
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
  if (error.status === 429 || error.code === "RATE_LIMITED") {
    return { field: null, text: `Demasiados intentos. ${describeWait(error)}` };
  }
  if (error.code === "RETRYABLE_CONFLICT") {
    return {
      field: null,
      text: "El sistema está ocupado. Intenta nuevamente en unos segundos.",
    };
  }
  return {
    field: null,
    text: "No fue posible cambiar la contraseña. Revisa los datos e intenta nuevamente.",
  };
}

/**
 * Current + new password form with its own validation, server error mapping
 * and focus handling. The error text sits right after the submit button.
 */
export function PasswordChangeForm({
  currentLabel,
  emptyCurrentMessage,
  invalidCurrentMessage,
  errorId,
  onSuccess,
  labelledBy,
  describedBy,
  footer,
}: {
  currentLabel: string;
  emptyCurrentMessage: string;
  invalidCurrentMessage: string;
  /** Must be unique per rendered instance (target of aria-describedby). */
  errorId: string;
  /**
   * Runs when the change succeeded, just before the session rotates. The
   * rotation remounts the screens, so this cannot rely on component state.
   */
  onSuccess?: () => void;
  labelledBy?: string;
  /** Id of text that explains the submit action (its accessible description). */
  describedBy?: string;
  /** Rendered inside the form, after the submit button and its error. */
  footer?: ReactNode;
}) {
  const change = useChangePasswordMutation({ onChanged: onSuccess });
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
      fail({ field: "currentPassword", text: emptyCurrentMessage });
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
        onError: (error) => fail(serverFailure(error, invalidCurrentMessage)),
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  return (
    <form
      noValidate
      aria-busy={pending}
      aria-labelledby={labelledBy}
      onSubmit={submit}
    >
      <PasswordInput
        label={currentLabel}
        inputRef={fields.currentPassword}
        name="currentPassword"
        autoComplete="current-password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
        required
        aria-invalid={passwordError?.field === "currentPassword"}
        aria-describedby={
          passwordError?.field === "currentPassword" ? errorId : undefined
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
          passwordError?.field === "newPassword" ? errorId : undefined
        }
      />
      <PendingButton
        type="submit"
        pending={pending}
        disabled={pending}
        aria-describedby={describedBy}
        announce={{ pending: "Cambiando contraseña" }}
      >
        Cambiar contraseña
      </PendingButton>
      {passwordError ? (
        <p role="alert" id={errorId}>
          {passwordError.text}
        </p>
      ) : null}
      {footer}
    </form>
  );
}
