import { useId, type ReactNode } from "react";

import { FieldMessage } from "../../../components/FieldMessage";
import type { CreateScopeOption } from "../invoiceCreateScopes";
import { MAX_BUSINESS_ID, MAX_SUPPLIER_NAME } from "../invoiceDraft";
import { invoiceLabel } from "../invoicePresentation";
import { BUSINESS_STATUSES } from "../types";
import type { useInvoiceCreateForm } from "../hooks/useInvoiceCreateForm";

type Form = ReturnType<typeof useInvoiceCreateForm>;

function ScopeOptions({ options }: { options: readonly CreateScopeOption[] }) {
  const organizations = [...new Set(options.map((o) => o.organizationId))];
  return (
    <>
      {organizations.map((organizationId) => {
        const own = options.filter((o) => o.organizationId === organizationId);
        return (
          <optgroup key={organizationId} label={own[0]?.organizationName}>
            {own.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

/** A label, its control and the persistent message that describes it. */
function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (props: {
    id: string;
    "aria-invalid": true | undefined;
    "aria-describedby": string;
  }) => ReactNode;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  const hintId = `${id}-hint`;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": hint ? `${messageId} ${hintId}` : messageId,
      })}
      <FieldMessage id={messageId} text={error} />
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The P0 create fields. Presentational: state, validation and the idempotent
 * attempt belong to `useInvoiceCreateForm`; the feedback and the submit
 * button are the screen's children.
 */
export function InvoiceCreateForm({
  form,
  options,
  children,
}: {
  form: Form;
  options: readonly CreateScopeOption[];
  children: ReactNode;
}) {
  const { values, errors, pending, change, register } = form;
  const titleId = useId();
  return (
    <form
      className="invoice-form"
      onSubmit={form.submit}
      noValidate
      aria-labelledby={titleId}
    >
      <h2 id={titleId}>Datos de la factura</h2>
      <Field label="Alcance de la factura">
        {(props) => (
          <select
            {...props}
            ref={register("scope")}
            value={form.scope?.value ?? ""}
            onChange={(event) =>
              !pending && form.selectScope(event.target.value)
            }
            aria-disabled={pending || undefined}
          >
            <ScopeOptions options={options} />
          </select>
        )}
      </Field>
      <Field label="Número de factura" error={errors.businessId}>
        {(props) => (
          <input
            {...props}
            ref={register("businessId")}
            value={values.businessId}
            maxLength={MAX_BUSINESS_ID + 20}
            onChange={(event) =>
              !pending && change("businessId", event.target.value)
            }
            readOnly={pending}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="Proveedor" error={errors.supplierName}>
        {(props) => (
          <input
            {...props}
            ref={register("supplierName")}
            value={values.supplierName}
            maxLength={MAX_SUPPLIER_NAME + 20}
            onChange={(event) =>
              !pending && change("supplierName", event.target.value)
            }
            readOnly={pending}
            autoComplete="off"
          />
        )}
      </Field>
      <div className="form-row">
        <Field
          label="Monto en pesos (CLP)"
          error={errors.amount}
          hint="Pesos chilenos enteros, por ejemplo 12.500."
        >
          {(props) => (
            <input
              {...props}
              ref={register("amount")}
              value={values.amount}
              inputMode="numeric"
              onChange={(event) =>
                !pending && change("amount", event.target.value)
              }
              readOnly={pending}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Estado de la factura">
          {(props) => (
            <select
              {...props}
              value={values.businessStatus}
              onChange={(event) =>
                !pending &&
                change(
                  "businessStatus",
                  event.target.value as (typeof BUSINESS_STATUSES)[number],
                )
              }
              aria-disabled={pending || undefined}
            >
              {BUSINESS_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {invoiceLabel(status)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="form-row">
        <Field label="Fecha de emisión" error={errors.issuedOn}>
          {(props) => (
            <input
              {...props}
              ref={register("issuedOn")}
              type="date"
              value={values.issuedOn}
              onChange={(event) =>
                !pending && change("issuedOn", event.target.value)
              }
              readOnly={pending}
            />
          )}
        </Field>
        <Field label="Fecha de vencimiento" error={errors.dueOn}>
          {(props) => (
            <input
              {...props}
              ref={register("dueOn")}
              type="date"
              value={values.dueOn}
              onChange={(event) =>
                !pending && change("dueOn", event.target.value)
              }
              readOnly={pending}
            />
          )}
        </Field>
      </div>
      <p className="field-hint">Moneda: peso chileno (CLP).</p>
      {children}
    </form>
  );
}
