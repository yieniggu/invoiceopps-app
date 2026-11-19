/**
 * Persistent live region for one field's validation text. It always exists,
 * so a message appearing never shifts the layout or re-announces the form.
 * `field` and `testId` are the optional selector anchors of the RPA contract.
 */
export function FieldMessage({
  id,
  text,
  field,
  testId,
}: {
  id: string;
  text?: string;
  field?: string;
  testId?: string;
}) {
  return (
    <p
      id={id}
      className="field-error"
      aria-live="polite"
      data-field={field}
      data-testid={testId}
    >
      {text ?? ""}
    </p>
  );
}
