import { useEffect, useLayoutEffect, useRef } from "react";

import { PendingButton } from "../../../components/PendingButton";
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
      <div
        className="screen-stack"
        data-screen="invoice-create"
        data-state="idle"
      >
        {BACK}
        <PageHeader
          title="Nueva factura"
          description="Registra una factura en tu organización o en uno de sus grupos."
        />
        <p
          id="invoice-create-forbidden"
          data-testid="invoice-create-forbidden"
          role="alert"
        >
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
  const retrying = form.uncertain && !confirming;

  // Persistent live region: it exists before it speaks.
  const status = pending ? "Creando factura" : created ? "Factura creada." : "";

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
  // The failure text may wrap to several lines; its height is kept (a ref, no
  // render) so the placeholder that replaces it while a request is out holds
  // the same box height instead of the one line `:empty` guarantees.
  const failureHeight = useRef(0);
  // The message re-wraps when the viewport resizes, so while it is mounted a
  // ResizeObserver keeps the measurement current (CR-447).
  useLayoutEffect(() => {
    const node = alert.current;
    if (!failure || !node) return;
    const measure = () => {
      failureHeight.current = node.getBoundingClientRect().height;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [failure]);
  const holdFailureHeight = (slot: HTMLParagraphElement | null) => {
    if (slot && failureHeight.current > 0)
      slot.style.minHeight = `${failureHeight.current}px`;
  };
  const createdHeading = useRef<HTMLHeadingElement>(null);
  const hasCreated = created !== undefined;
  useEffect(() => {
    if (hasCreated) createdHeading.current?.focus();
  }, [hasCreated]);

  return (
    <div
      className="screen-stack"
      data-screen="invoice-create"
      data-state={form.state}
    >
      {BACK}
      <PageHeader
        title="Nueva factura"
        description="Registra una factura en tu organización o en uno de sus grupos."
      />
      <p role="status" className="visually-hidden">
        {status}
      </p>
      {created ? (
        <section
          id="invoice-create-created"
          data-testid="invoice-create-created"
          data-invoice-id={created.invoice.id}
          data-business-id={created.invoice.businessId}
          className="invoice-created"
          aria-labelledby="created-title"
        >
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
            <button
              id="invoice-create-another"
              data-testid="invoice-create-another"
              type="button"
              onClick={form.restart}
            >
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
          {failure || retrying || (pending && form.afterFailure) ? (
            <div
              className={
                !failure && pending
                  ? "inbox-alert inbox-alert--pending"
                  : "inbox-alert"
              }
            >
              {/* While a request is out the failure is gone (contract §2.2); an
                  empty, neutral placeholder holds its slot so the box does not
                  jump. The submit button label is the one visible progress
                  signal and the persistent hidden status the only announcer. */}
              {!failure && pending ? (
                <p
                  id={
                    retrying
                      ? "invoice-create-retrying"
                      : "invoice-create-sending"
                  }
                  data-testid={
                    retrying
                      ? "invoice-create-retrying"
                      : "invoice-create-sending"
                  }
                  className="inbox-alert-slot"
                  ref={holdFailureHeight}
                />
              ) : null}
              {failure ? (
                <p
                  id="invoice-create-failure"
                  data-testid="invoice-create-failure"
                  data-failure-kind={failure.kind}
                  data-error-status={failure.status}
                  data-error-code={failure.code}
                  role="alert"
                  ref={alert}
                  tabIndex={-1}
                >
                  {failure.message}
                </p>
              ) : null}
              {retrying ? (
                <button
                  id="invoice-create-retry"
                  data-testid="invoice-create-retry"
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
                  id="invoice-create-confirm-new"
                  data-testid="invoice-create-confirm-new"
                  type="button"
                  aria-disabled={pending || undefined}
                  onClick={form.confirmNewOperation}
                >
                  Crear como operación nueva
                </button>
                <button
                  id="invoice-create-confirm-cancel"
                  data-testid="invoice-create-confirm-cancel"
                  type="button"
                  className="secondary-button"
                  onClick={form.dismissConfirmation}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}
          <PendingButton
            id="invoice-create-submit"
            data-testid="invoice-create-submit"
            type="submit"
            aria-disabled={pending || undefined}
            pending={pending}
          >
            Crear factura
          </PendingButton>
        </InvoiceCreateForm>
      )}
    </div>
  );
}
