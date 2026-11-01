import { useEffect, useRef } from "react";

import { BackLink } from "../../../components/BackLink";
import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { InvoiceCreateForm } from "../components/InvoiceCreateForm";
import { useInvoiceCreateForm } from "../hooks/useInvoiceCreateForm";
import { useInvoiceCreateScopeOptions } from "../hooks/useInvoiceCreateScopeOptions";
import type { CreateScopeOption } from "../invoiceCreateScopes";
import { invoiceMoney } from "../invoicePresentation";

const BACK = <BackLink to={paths.invoices}>Volver a facturas</BackLink>;

/**
 * Create an invoice. Only scopes where the person can create are offered; the
 * API stays the authority and answers 403/404 to anything else.
 */
export function CreateInvoiceScreen({ profile }: { profile: Profile }) {
  const options = useInvoiceCreateScopeOptions(profile);
  if (options.length === 0)
    return (
      <div className="screen-stack">
        {BACK}
        <PageHeader
          title="Nueva factura"
          description="Registra una factura en tu organización o en uno de sus grupos."
        />
        <p role="alert">
          No tienes permiso para crear facturas. Pide a un administrador de tu
          organización que te lo otorgue.
        </p>
      </div>
    );
  return <CreateInvoiceContainer options={options} />;
}

function CreateInvoiceContainer({
  options,
}: {
  options: readonly CreateScopeOption[];
}) {
  const form = useInvoiceCreateForm(options);
  const { created, failure, confirming, confirmationRequests, pending } = form;

  // Persistent live region: it exists before it speaks.
  const status = pending
    ? "Creando la factura…"
    : created
      ? "Factura creada."
      : "";

  const confirmation = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (confirming) confirmation.current?.focus();
  }, [confirming, confirmationRequests]);
  // A failure takes focus to what the person can act on: «Reintentar» when the
  // attempt can be repeated, otherwise the message. A field error has already
  // focused its field, and a confirmation takes focus itself.
  const alert = useRef<HTMLParagraphElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!failure || failure.kind === "burned") return;
    if (failure.kind === "rejected" && failure.field) return;
    (retry.current ?? alert.current)?.focus();
  }, [failure]);
  const createdHeading = useRef<HTMLHeadingElement>(null);
  const hasCreated = created !== undefined;
  useEffect(() => {
    if (hasCreated) createdHeading.current?.focus();
  }, [hasCreated]);

  return (
    <div className="screen-stack">
      {BACK}
      <PageHeader
        title="Nueva factura"
        description="Registra una factura en tu organización o en uno de sus grupos."
      />
      <p role="status" className="visually-hidden">
        {status}
      </p>
      {created ? (
        <section className="invoice-created" aria-labelledby="created-title">
          <h2 id="created-title" ref={createdHeading} tabIndex={-1}>
            Factura creada
          </h2>
          <p>
            {created.invoice.businessId} de {created.invoice.supplierName} por{" "}
            {invoiceMoney(created.invoice.amountPesos)} en{" "}
            {created.scope.groupId === null
              ? `${created.scope.organizationName} (sin grupo)`
              : `${created.scope.label} · ${created.scope.organizationName}`}
            .
          </p>
          <div className="action-row">
            <button type="button" onClick={form.restart}>
              Crear otra
            </button>
            {created.scope.canRead ? (
              <LinkButton
                variant="secondary"
                to={paths.invoice(created.invoice.id, created.invoice)}
              >
                Ver factura
              </LinkButton>
            ) : null}
            <LinkButton variant="secondary" to={paths.invoices}>
              Ir a facturas
            </LinkButton>
          </div>
        </section>
      ) : (
        <InvoiceCreateForm form={form} options={options}>
          {failure ? (
            <div className="inbox-alert">
              <p role="alert" ref={alert} tabIndex={-1}>
                {failure.message}
              </p>
              {form.uncertain && !confirming ? (
                <button
                  ref={retry}
                  type="button"
                  className="secondary-button"
                  aria-disabled={pending || undefined}
                  onClick={() => form.submit()}
                >
                  Reintentar
                </button>
              ) : null}
            </div>
          ) : null}
          {confirming ? (
            <div
              className="inbox-alert"
              role="group"
              aria-label="Operación nueva"
            >
              <p ref={confirmation} tabIndex={-1}>
                Esto se enviará como una operación nueva. Si el intento anterior
                sí alcanzó a crear la factura, podría quedar duplicada: revisa
                la lista de facturas antes de continuar.
              </p>
              <div className="action-row">
                <button
                  type="button"
                  aria-disabled={pending || undefined}
                  onClick={form.confirmNewOperation}
                >
                  Crear como operación nueva
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={form.dismissConfirmation}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}
          <button
            type="submit"
            aria-disabled={pending || undefined}
            aria-busy={pending}
          >
            {pending ? "Creando factura…" : "Crear factura"}
          </button>
        </InvoiceCreateForm>
      )}
    </div>
  );
}
