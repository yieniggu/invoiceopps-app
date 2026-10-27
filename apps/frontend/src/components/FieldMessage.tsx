/**
 * Persistent live region for one field's validation text. It always exists,
 * so a message appearing never shifts the layout or re-announces the form.
 */
export function FieldMessage({ id, text }: { id: string; text?: string }) {
  return (
    <p id={id} className="field-error" aria-live="polite">
      {text ?? ""}
    </p>
  );
}
