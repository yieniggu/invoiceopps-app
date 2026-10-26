import { useId, useState, type Ref } from "react";

import { isValidRut, nextRutInputValue } from "../lib/rut";

interface RutFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Label text wrapping the input. Use `ariaLabel` for an unwrapped input. */
  label?: string;
  ariaLabel?: string;
  name?: string;
  autoComplete?: string;
  disabled?: boolean;
  required?: boolean;
  /** Set after a submit attempt so an invalid RUT reports its error. */
  submitted?: boolean;
  /** Lets the parent move focus here, e.g. to the first invalid field. */
  inputRef?: Ref<HTMLInputElement>;
}

export function RutField({
  value,
  onChange,
  label,
  ariaLabel,
  name,
  autoComplete,
  disabled,
  required,
  submitted = false,
  inputRef,
}: RutFieldProps) {
  const errorId = useId();
  const [touched, setTouched] = useState(false);
  const showError =
    value !== "" && !isValidRut(value) && (touched || submitted);
  const input = (
    <input
      ref={inputRef}
      name={name}
      aria-label={ariaLabel}
      inputMode="text"
      autoComplete={autoComplete}
      value={value}
      onChange={(event) =>
        onChange(nextRutInputValue(value, event.target.value))
      }
      onBlur={() => setTouched(true)}
      disabled={disabled}
      required={required}
      aria-invalid={showError}
      aria-describedby={showError ? errorId : undefined}
    />
  );

  return (
    <>
      {label ? (
        <label>
          {label}
          {input}
        </label>
      ) : (
        input
      )}
      {showError ? (
        <p id={errorId} className="field-error" role="alert">
          RUT inválido
        </p>
      ) : null}
    </>
  );
}
