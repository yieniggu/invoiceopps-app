import { Eye, EyeOff } from "lucide-react";
import { useId, useState, type InputHTMLAttributes, type Ref } from "react";

interface PasswordInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "id"
> {
  /** Visible label text; the label is tied to the input with `htmlFor`. */
  label: string;
  /** Lets the parent move focus here, e.g. to the first invalid field. */
  inputRef?: Ref<HTMLInputElement>;
}

/** Constant name of the toggle: its state is `aria-pressed`, never the label. */
const TOGGLE_LABEL = "Mostrar contraseña";

/**
 * Password field with a show/hide button inside it. The button is a plain
 * `type="button"` (never submits) and keeps focus after toggling, so the
 * person can press it again from the keyboard. It is a toggle button: the
 * accessible name stays "Mostrar contraseña" and `aria-pressed` says whether
 * the password is visible (one mechanism, so a screen reader never hears the
 * state twice). The input keeps every other attribute (autocomplete, aria-*,
 * validation) the caller passes.
 */
export function PasswordInput({
  label,
  inputRef,
  disabled,
  ...inputProps
}: PasswordInputProps) {
  const inputId = useId();
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className="password-field">
      <label htmlFor={inputId}>{label}</label>
      <div className="password-control">
        <input
          {...inputProps}
          id={inputId}
          ref={inputRef}
          type={visible ? "text" : "password"}
          disabled={disabled}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={TOGGLE_LABEL}
          title={TOGGLE_LABEL}
          aria-pressed={visible}
          aria-controls={inputId}
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
        >
          <Icon aria-hidden="true" focusable="false" size={18} />
        </button>
      </div>
    </div>
  );
}
