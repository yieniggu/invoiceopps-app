import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Dialog } from "../../../components/Dialog";
import { PendingButton } from "../../../components/PendingButton";
import { FieldMessage } from "../../../components/FieldMessage";
import {
  describeExpiry,
  expiryBounds,
  floorToMinute,
  MAX_EXPIRY_DAYS,
  resolveExpiry,
  type ExpiryChoice,
} from "../apiTokenExpiry";
import {
  describeTokenFailure,
  expiryRefusal,
  retainAllowed,
  SCOPE_LABELS,
  type TokenScopeOption,
} from "../apiTokenScopes";
import { useNow } from "../useNow";
import type { ApiTokenInput, ApiTokenScope } from "../types";

const MAX_NAME = 120;

interface Errors {
  name?: string;
  scopes?: string;
  expiry?: string;
}

/** A label, its control and the persistent message that describes it. */
function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-invalid": true | undefined;
    "aria-describedby": string;
  }) => ReactNode;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": messageId,
      })}
      <FieldMessage id={messageId} text={error} />
    </div>
  );
}

/**
 * Form of a new token. It owns only what the person types; the request, its
 * outcome and the secret belong to the screen. Escape and «Cancelar» close it
 * even while a request is out: the screen then drops that emission's answer.
 *
 * While a request is out the controls are read-only or `aria-disabled`, never
 * `disabled`: a disabled control that has focus sends it to the page, and the
 * person loses their place. A failure moves focus to its message.
 */
export function IssueApiTokenDialog({
  options,
  pending,
  failure,
  onSubmit,
  onClose,
  returnFocusTo,
}: {
  options: readonly TokenScopeOption[];
  pending: boolean;
  failure: { error: unknown } | undefined;
  onSubmit: (input: ApiTokenInput) => void;
  onClose: () => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const [scopeValue, setScopeValue] = useState<string>();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<ApiTokenScope[]>([]);
  const [choice, setChoice] = useState<ExpiryChoice>("29");
  const [date, setDate] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const nameField = useRef<HTMLInputElement>(null);
  const firstScope = useRef<HTMLInputElement>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const expiryGroup = useRef<HTMLFieldSetElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  // Synchronous: `pending` only changes after the render that follows, so two
  // submits in the same tick would both pass it.
  const inflight = useRef(false);
  const [expiryEdited, setExpiryEdited] = useState(false);
  const permissionsId = useId();
  const expiryId = useId();

  // A scope that is no longer offered gives way to the first one.
  const scope = options.find(({ value }) => value === scopeValue) ?? options[0];
  const allowed = scope?.allowed ?? [];
  // What the scope does not allow is never sent, even before the effect of a
  // change of scope has run.
  const checked = retainAllowed(selected, allowed);
  // Refreshed on every minute of the clock, so a dialog left open keeps
  // previewing the instant a submit would send. Both use the same minute.
  const now = useNow(60_000);
  const bounds = expiryBounds(now);
  const refusal = expiryRefusal(failure?.error);
  // What would be sent right now, in the person's own time zone.
  const expiryPreview = describeExpiry({ choice, date }, floorToMinute(now));

  useEffect(() => {
    if (!pending) inflight.current = false;
  }, [pending]);

  // A failure takes focus to what describes it (the alert, or the expiry
  // field when the server refused the date).
  const failedWith = failure?.error;
  useEffect(() => {
    if (failedWith === undefined) return;
    if (expiryRefusal(failedWith))
      (
        dateField.current ??
        expiryGroup.current?.querySelector<HTMLInputElement>("input:checked")
      )?.focus();
    else alert.current?.focus();
  }, [failedWith]);

  const selectScope = (value: string) => {
    if (pending) return;
    setScopeValue(value);
    const next = options.find((option) => option.value === value);
    setSelected((current) => retainAllowed(current, next?.allowed ?? []));
    setErrors((current) => ({ ...current, scopes: undefined }));
  };

  const toggle = (value: ApiTokenScope) => {
    if (pending) return;
    setSelected(
      checked.includes(value)
        ? checked.filter((item) => item !== value)
        : [...checked, value],
    );
    setErrors((current) => ({ ...current, scopes: undefined }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || inflight.current || !scope) return;
    const trimmed = name.trim();
    const found: Errors = {};
    if (trimmed === "") found.name = "Escribe un nombre para el token.";
    else if (trimmed.length > MAX_NAME)
      found.name = `El nombre no puede superar los ${MAX_NAME} caracteres.`;
    if (checked.length === 0) found.scopes = "Elige al menos un permiso.";
    const expiry = resolveExpiry({ choice, date }, floorToMinute(new Date()));
    if ("error" in expiry) found.expiry = expiry.error;
    setErrors(found);
    if (found.name) nameField.current?.focus();
    else if (found.scopes) firstScope.current?.focus();
    else if (found.expiry) dateField.current?.focus();
    if (found.name || found.scopes || "error" in expiry) return;
    inflight.current = true;
    setExpiryEdited(false);
    onSubmit({
      name: trimmed,
      organizationId: scope.organizationId,
      ...(scope.groupId === null ? {} : { groupId: scope.groupId }),
      scopes: allowed.filter((item) => checked.includes(item)),
      expiresAt: expiry.expiresAt,
    });
  };

  const groups = [...new Set(options.map((option) => option.organizationId))];

  return (
    <Dialog
      title="Emitir token"
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <form className="invoice-form" onSubmit={submit} noValidate>
        <Field label="Alcance del token">
          {(props) => (
            <select
              {...props}
              value={scope?.value ?? ""}
              onChange={(event) => selectScope(event.target.value)}
              aria-disabled={pending || undefined}
            >
              {groups.map((organizationId) => {
                const own = options.filter(
                  (option) => option.organizationId === organizationId,
                );
                return (
                  <optgroup
                    key={organizationId}
                    label={own[0]?.organizationName}
                  >
                    {own.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          )}
        </Field>
        <Field label="Nombre del token" error={errors.name}>
          {(props) => (
            <input
              {...props}
              ref={nameField}
              value={name}
              maxLength={MAX_NAME + 20}
              autoComplete="off"
              readOnly={pending}
              onChange={(event) => {
                if (pending) return;
                setName(event.target.value);
                setErrors((current) => ({ ...current, name: undefined }));
              }}
            />
          )}
        </Field>
        <fieldset
          className="plain-fieldset choice-group"
          aria-describedby={`${permissionsId}-message`}
        >
          <legend>Permisos del token</legend>
          {allowed.map((value, index) => (
            <label key={value} className="check-row">
              <input
                ref={index === 0 ? firstScope : undefined}
                type="checkbox"
                checked={checked.includes(value)}
                aria-disabled={pending || undefined}
                onChange={() => toggle(value)}
              />
              {SCOPE_LABELS[value]}
            </label>
          ))}
          <FieldMessage id={`${permissionsId}-message`} text={errors.scopes} />
          <p className="field-hint">
            Solo se ofrecen los permisos que tienes en este alcance.
          </p>
        </fieldset>
        <fieldset
          ref={expiryGroup}
          className="plain-fieldset choice-group"
          aria-describedby={`${expiryId}-message`}
        >
          <legend>Caducidad</legend>
          {(
            [
              ["7", "7 días"],
              ["29", "29 días"],
              ["custom", "Otra fecha"],
            ] as const
          ).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name={`${expiryId}-expiry`}
                checked={choice === value}
                aria-disabled={pending || undefined}
                onChange={() => {
                  if (pending) return;
                  setExpiryEdited(true);
                  setChoice(value);
                  setErrors((current) => ({ ...current, expiry: undefined }));
                }}
              />
              {label}
            </label>
          ))}
          {choice === "custom" ? (
            <Field label="Fecha de caducidad">
              {(props) => (
                <input
                  {...props}
                  ref={dateField}
                  type="date"
                  value={date}
                  min={bounds.min}
                  max={bounds.max}
                  readOnly={pending}
                  onChange={(event) => {
                    if (pending) return;
                    setExpiryEdited(true);
                    setDate(event.target.value);
                    setErrors((current) => ({ ...current, expiry: undefined }));
                  }}
                />
              )}
            </Field>
          ) : null}
          <FieldMessage
            id={`${expiryId}-message`}
            text={errors.expiry ?? (expiryEdited ? undefined : refusal)}
          />
          <p className="field-hint" aria-live="polite">
            {expiryPreview ?? ""}
          </p>
          <p className="field-hint">
            Un token dura hasta {MAX_EXPIRY_DAYS} días.
          </p>
        </fieldset>
        {failure && !refusal ? (
          <p role="alert" ref={alert} tabIndex={-1}>
            {describeTokenFailure(failure.error, "issue")}
          </p>
        ) : null}
        <div className="action-row">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <PendingButton
            type="submit"
            pending={pending}
            aria-disabled={pending || undefined}
            announce={{ pending: "Emitiendo token" }}
          >
            Emitir token
          </PendingButton>
        </div>
      </form>
    </Dialog>
  );
}
