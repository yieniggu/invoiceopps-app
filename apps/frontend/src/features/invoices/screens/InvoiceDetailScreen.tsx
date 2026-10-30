import { Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

import { BackLink } from "../../../components/BackLink";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { isUuid } from "../../../lib/uuid";
import type { Profile } from "../../auth/types";
import { paths, type RouteNotice } from "../../navigation/paths";
import { DeleteInvoiceDialog } from "../components/DeleteInvoiceDialog";
import { InvoiceStatusBadge } from "../components/InvoiceStatusBadge";
import { groupLabel } from "../components/InvoiceTable";
import { useDeleteInvoice } from "../hooks/useDeleteInvoice";
import { useInvoiceQuery } from "../hooks/useInvoice";
import { scopeFromSearch } from "../invoiceScopes";
import { canDeleteInvoiceFromProfile } from "../invoiceDeletion";
import { invoiceFiltersFromSearch, invoiceSearch } from "../invoiceFilters";
import {
  invoiceCivilDate,
  invoiceDate,
  invoiceLabel,
  invoiceMoney,
  isOverdue,
} from "../invoicePresentation";

/**
 * Inbox URL to go back to: the state the row link carried (normalised, so a
 * forged history entry cannot inject parameters), or else the scope of the
 * detail's own URL.
 */
function backSearch(state: unknown, organizationId: string, groupId?: string) {
  const carried =
    typeof state === "object" &&
    state !== null &&
    "inboxSearch" in state &&
    typeof state.inboxSearch === "string"
      ? new URLSearchParams(state.inboxSearch)
      : undefined;
  const scope = carried && scopeFromSearch(carried);
  if (carried && scope)
    return invoiceSearch(scope, invoiceFiltersFromSearch(carried));
  return invoiceSearch(
    groupId
      ? { kind: "group", organizationId, groupId }
      : { kind: "organization", organizationId },
    { q: "", page: 1 },
  );
}

function Definition({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const DELETE_MESSAGES = {
  FORBIDDEN: "No tienes permiso para eliminar esta factura.",
  NOT_FOUND: "La factura ya no existe o no está disponible.",
};

/**
 * One invoice: business data, and the processing status apart. The delete
 * action follows the profile (presentation); the API stays the authority.
 */
export function InvoiceDetailScreen({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const { invoiceId = "" } = useParams();
  const [params] = useSearchParams();
  const { state } = useLocation();
  const organizationId = params.get("organizationId") ?? "";
  const groupId = params.get("groupId") ?? undefined;
  // A link that cannot name an invoice is "not found" without asking the API.
  const wellFormed =
    isUuid(invoiceId) &&
    isUuid(organizationId) &&
    (groupId === undefined || isUuid(groupId));
  const remove = useDeleteInvoice(organizationId, groupId, invoiceId);
  // Once deleted, nothing may ask for the invoice again.
  const { query, forbidden, notFound } = useInvoiceQuery(
    organizationId,
    groupId,
    invoiceId,
    wellFormed && !remove.isSuccess,
  );
  const inboxUrl = paths.invoicesWith(
    wellFormed ? backSearch(state, organizationId, groupId) : "",
  );
  const back = <BackLink to={inboxUrl}>Volver a facturas</BackLink>;
  const deleteFeedback = (
    <MutationFeedback
      isError={remove.isError}
      error={remove.error}
      isSuccess={false}
      success=""
      fallback="No fue posible eliminar la factura."
      messages={DELETE_MESSAGES}
      focusOnError
    />
  );

  if (!wellFormed || notFound)
    return (
      <div className="screen-stack">
        <PageHeader
          title="Factura no encontrada"
          description="La factura no existe o no está disponible para tu sesión."
        />
        {back}
        {deleteFeedback}
      </div>
    );

  const invoice = forbidden ? undefined : query.data;
  const canDelete = invoice && canDeleteInvoiceFromProfile(profile, invoice);
  return (
    <div className="screen-stack">
      {back}
      <PageHeader
        title={invoice ? invoice.businessId : "Factura"}
        titleAddon={
          invoice ? (
            <InvoiceStatusBadge status={invoice.businessStatus} />
          ) : undefined
        }
        description={invoice ? invoice.supplierName : undefined}
        action={
          canDelete ? (
            <button
              ref={trigger}
              type="button"
              className="subtle-danger-button"
              onClick={() => {
                remove.reset();
                setConfirming(true);
              }}
            >
              <Trash2 aria-hidden="true" focusable="false" size={16} />
              Eliminar factura
            </button>
          ) : undefined
        }
      />
      {deleteFeedback}
      {forbidden ? (
        <p role="alert">No tienes permiso para ver esta factura.</p>
      ) : (
        <QueryFeedback
          query={{
            isPending: query.isPending,
            isError: query.isError,
            data: invoice,
            refetch: query.refetch,
          }}
          loading="Cargando factura..."
          error="No fue posible cargar la factura."
          staleError="No fue posible actualizar la factura; lo que ves puede estar desactualizado."
          retryLabel="Reintentar"
        />
      )}
      {invoice ? (
        <div
          className="invoice-summary"
          role="group"
          aria-label="Resumen de la factura"
        >
          <p className="invoice-amount">
            <span className="invoice-amount-label">Monto</span>
            <strong>{invoiceMoney(invoice.amountPesos)}</strong>
          </p>
          <dl className="invoice-facts">
            <Definition term="Emisión">
              {invoiceCivilDate(invoice.issuedOn)}
            </Definition>
            <Definition term="Vencimiento">
              {invoiceCivilDate(invoice.dueOn)}
              {isOverdue(invoice) ? (
                <span className="overdue-label">Vencida</span>
              ) : null}
            </Definition>
            <Definition term="Grupo">{groupLabel(invoice)}</Definition>
            <Definition term="Procesamiento">
              {invoiceLabel(invoice.processingStatus)}
            </Definition>
            <Definition term="Creada">
              {invoiceDate(invoice.createdAt)}
            </Definition>
          </dl>
        </div>
      ) : null}
      {invoice && confirming ? (
        <DeleteInvoiceDialog
          invoice={invoice}
          pending={remove.isPending}
          returnFocusTo={trigger}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            // A second click can land before the pending state renders.
            if (submitted.current) return;
            submitted.current = true;
            remove.mutate(undefined, {
              onSuccess: () =>
                navigate(inboxUrl, {
                  // The deleted detail must not be one Back away.
                  replace: true,
                  state: { notice: "Factura eliminada." } satisfies RouteNotice,
                }),
              onError: () => setConfirming(false),
              onSettled: () => {
                submitted.current = false;
              },
            });
          }}
        />
      ) : null}
    </div>
  );
}
