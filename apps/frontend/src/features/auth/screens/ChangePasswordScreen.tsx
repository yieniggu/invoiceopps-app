import { LogOut } from "lucide-react";

import { ThemeToggle } from "../../../components/ThemeToggle";
import { PasswordChangeForm } from "../components/PasswordChangeForm";
import { useLogoutMutation } from "../hooks/useAuthMutations";

/** The only screen a person with a pending temporary password can use. */
export function ChangePasswordScreen() {
  const logout = useLogoutMutation();

  return (
    <main
      className="shell"
      data-screen="onboarding"
      aria-labelledby="password-change-title"
    >
      <div className="shell-toolbar">
        <ThemeToggle />
      </div>
      <p className="eyebrow">InvoiceOps</p>
      <h1 id="password-change-title">Cambia tu contraseña temporal</h1>
      <p>
        Debes establecer una contraseña nueva antes de acceder al resto de la
        aplicación.
      </p>
      <PasswordChangeForm
        currentLabel="Contraseña temporal"
        emptyCurrentMessage="Ingresa tu contraseña temporal."
        invalidCurrentMessage="La contraseña temporal no es correcta."
        errorId="password-change-error"
      />
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
