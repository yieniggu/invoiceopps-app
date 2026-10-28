// Shared layer (RV-097): used by more than one feature, so it stays in
// `src/components` next to `src/lib/rut.ts` instead of inside a feature.
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type Ref,
} from "react";

import { caretAfterFormat, isValidRut, nextRutInputValue } from "../lib/rut";

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
  /** Set after a submit attempt so an invalid or missing RUT reports itself. */
  submitted?: boolean;
  /** Shown when a required RUT is missing; forms about another person override it. */
  missingMessage?: string;
  /** Lets the parent move focus here, e.g. to the first invalid field. */
  inputRef?: Ref<HTMLInputElement>;
  /** A server-side rejection of this RUT (e.g. already registered). */
  serverMessage?: string;
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
  missingMessage = "Ingresa tu RUT",
  inputRef,
  serverMessage = "",
}: RutFieldProps) {
  const errorId = useId();
  const element = useRef<HTMLInputElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const [touched, setTouched] = useState(false);

  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      element.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef)
        (inputRef as MutableRefObject<HTMLInputElement | null>).current = node;
    },
    [inputRef],
  );

  // RV-094: reformatting replaces the whole value, which would send the caret
  // to the end; put it back next to the character being edited.
  useLayoutEffect(() => {
    const node = element.current;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    if (node && caret !== null && document.activeElement === node)
      node.setSelectionRange(caret, caret);
  });

  const invalid = value !== "" && !isValidRut(value);
  const missing = value === "" && required === true && submitted;
  // The message is derived, never inserted: the live region below always
  // exists, so it neither shifts the layout nor re-announces while typing.
  const message =
    invalid && (touched || submitted)
      ? "RUT inválido"
      : missing
        ? missingMessage
        : serverMessage;

  const input = (
    <input
      ref={setRefs}
      name={name}
      aria-label={ariaLabel}
      inputMode="text"
      autoComplete={autoComplete}
      value={value}
      onChange={(event) => {
        const target = event.target;
        const next = nextRutInputValue(value, target.value);
        const caret =
          target.selectionStart === null
            ? null
            : caretAfterFormat(target.value, target.selectionStart, next);
        pendingCaret.current = caret;
        onChange(next);
        // Nothing to re-render (e.g. a rejected character): React restores
        // the old value after this handler, so restore the caret after that.
        if (next === value && caret !== null)
          queueMicrotask(() => {
            if (document.activeElement === target)
              target.setSelectionRange(caret, caret);
          });
      }}
      onBlur={() => setTouched(true)}
      disabled={disabled}
      required={required}
      aria-invalid={message !== ""}
      aria-describedby={errorId}
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
      <p id={errorId} className="field-error" aria-live="polite">
        {message}
      </p>
    </>
  );
}
