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
  id: contractId,
  name,
  label,
  error,
  hint,
  children,
}: {
  /** Stable contract id (control id and `data-testid`); absent: generated. */
  id?: string;
  name?: string;
  label: string;
  error?: string;
  hint?: string;
  children: (props: {
    id: string;
    name?: string;
    "data-testid"?: string;
    "aria-invalid": true | undefined;
    "aria-describedby": string;
  }) => ReactNode;
}) {
  const generatedId = useId();
  const id = contractId ?? generatedId;
  const messageId = contractId ? `${id}-error` : `${id}-message`;
  const hintId = `${id}-hint`;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        name,
        "data-testid": contractId,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": hint ? `${messageId} ${hintId}` : messageId,
      })}
      <FieldMessage
        id={messageId}
        text={error}
        testId={contractId ? messageId : undefined}
        field={contractId ? name : undefined}
      />
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
      id="invoice-create-form"
      data-testid="invoice-create-form"
      data-state={form.state}
      className="invoice-form"
      onSubmit={form.submit}
      noValidate
      aria-labelledby={titleId}
    >
      <h2 id={titleId}>Datos de la factura</h2>
      <Field
        id="invoice-create-scope"
        name="scope"
        label="Alcance de la factura"
      >
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
      <Field
        id="invoice-create-business-id"
        name="businessId"
        label="Número de factura"
        error={errors.businessId}
      >
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
      <Field
        id="invoice-create-supplier-name"
        name="supplierName"
        label="Proveedor"
        error={errors.supplierName}
      >
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
          id="invoice-create-amount"
          name="amount"
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
        <Field
          id="invoice-create-business-status"
          name="businessStatus"
          label="Estado de la factura"
        >
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
        <Field
          id="invoice-create-issued-on"
          name="issuedOn"
          label="Fecha de emisión"
          error={errors.issuedOn}
        >
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
        <Field
          id="invoice-create-due-on"
          name="dueOn"
          label="Fecha de vencimiento"
          error={errors.dueOn}
        >
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
