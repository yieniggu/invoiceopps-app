import { useEffect, useRef, useState } from "react";

import "./tailwind.css";
import { contextValue, useWorkspace } from "../workspace/WorkspaceContext";
import { useUnauthorized } from "../auth/ProtectedSession";
import { useInvoiceDecisions } from "./InvoiceDecisions";
import { EvaluationScreen } from "./EvaluationScreen";
import { InvoiceAuditHistory } from "./InvoiceAuditHistory";
import {
  invoiceMoney as money,
  invoiceLabel,
  invoiceNumber,
  invoiceDate,
  invoiceHttpMessage,
} from "./invoicePresentation";

type Profile = {
  id: string;
  memberships: Array<{
    organization: { id: string; name: string };
    role: string;
  }>;
};

type Group = {
  id: string;
  name: string;
  organization: { id: string; name: string };
};
type InvoiceListItem = {
  invoiceId: string;
  vendorName: string;
  invoiceAmountCents: number;
  hasPurchaseOrder: boolean;
  threeWayMatch: boolean;
  status: string;
  policyProbability: number | null;
  policyProbabilitySource: string | null;
};
export type InvoiceDetail = InvoiceListItem & {
  riskContext: {
    vendorTenureDays: number;
    previousIncidents12m: number;
    bankAccountRecentlyChanged: boolean;
    amountVsVendorMedian: number;
    countryRisk: string;
  };
  createdAt: string;
  updatedAt: string;
};
export type AuditEvent = {
  decision: string;
  ruleVersion: string;
  mode: string;
  policyVersion: string | null;
  manualReviewThreshold: number | null;
  policyProbability: number | null;
  policyProbabilitySource: string | null;
  modelId: string | null;
  modelVersion: string | null;
  modelRunId: string | null;
  recommendation: string | null;
  actor: { name: string; rut: string };
  correlationId: string;
  createdAt: string;
};
type ListState =
  | { kind: "loading" }
  | { kind: "error"; status?: number }
  | {
      kind: "loaded";
      contextKey: string;
      invoices: InvoiceListItem[];
      nextCursor: string | null;
    };
type DetailState =
  | { kind: "loading" }
  | { kind: "error"; status?: number }
  | { kind: "loaded"; invoice: InvoiceDetail; auditEvents: AuditEvent[] };

class InvoiceReadError extends Error {
  constructor(readonly status: number) {
    super("Invoice read failed");
  }
}

function yesNo(value: boolean) {
  return value ? "Sí" : "No";
}

export function InvoiceWorkspace({
  profile,
  groups,
}: {
  profile: Profile;
  groups: Group[];
}) {
  const {
    contexts: availableContexts,
    selectedValue,
    setSelectedValue,
    selectedContext,
    ownerSelectorRef,
  } = useWorkspace(profile, groups);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<number | null>(null);
  const pageRequest = useRef<object | null>(null);
  const [detailId, setDetailId] = useState<string>();
  const [detailState, setDetailState] = useState<DetailState>({
    kind: "loading",
  });
  const unauthorized = useUnauthorized();
  const [expired, setExpired] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pageRequest.current = null;
    };
  }, []);
  const { get, execute, reconcile } = useInvoiceDecisions();
  const decisionKey =
    selectedContext && detailId
      ? `${contextValue(selectedContext)}:${detailId}`
      : "";
  const operation = get(decisionKey);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [policyVersion, setPolicyVersion] = useState("");
  const [evaluationOpen, setEvaluationOpen] = useState(false);

  useEffect(() => {
    if (!selectedContext) {
      setListState({
        kind: "loaded",
        contextKey: "",
        invoices: [],
        nextCursor: null,
      });
      return;
    }
    let cancelled = false;
    pageRequest.current = null;
    setIsLoadingMore(false);
    setPageError(null);
    const contextKey = `${contextValue(selectedContext)}:${submittedQuery}`;
    setListState({ kind: "loading" });
    const params = new URLSearchParams({
      organizationId: selectedContext.organizationId,
      ownerType: selectedContext.ownerType,
      ownerId: selectedContext.ownerId,
      q: submittedQuery,
    });
    void fetch(`/invoices?${params}`, { credentials: "same-origin" })
      .then(async (response) => {
        if (response.status === 401) {
          if (!cancelled) {
            setExpired(true);
            unauthorized();
          }
          return null;
        }
        if (!response.ok) throw new InvoiceReadError(response.status);
        return (await response.json()) as {
          invoices: InvoiceListItem[];
          nextCursor: string | null;
        };
      })
      .then((result) => {
        if (!cancelled && result)
          setListState({ kind: "loaded", contextKey, ...result });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setListState({
            kind: "error",
            status:
              error instanceof InvoiceReadError ? error.status : undefined,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [
    reloadKey,
    selectedContext?.organizationId,
    selectedContext?.ownerId,
    selectedContext?.ownerType,
    submittedQuery,
    unauthorized,
  ]);

  const loadMore = async () => {
    if (
      !selectedContext ||
      pageRequest.current ||
      listState.kind !== "loaded" ||
      !listState.nextCursor
    ) {
      return;
    }

    const cursor = listState.nextCursor;
    const request = {};
    pageRequest.current = request;
    const isCurrent = () => mounted.current && pageRequest.current === request;
    const contextKey = `${contextValue(selectedContext)}:${submittedQuery}`;
    setIsLoadingMore(true);
    setPageError(null);
    try {
      const params = new URLSearchParams({
        organizationId: selectedContext.organizationId,
        ownerType: selectedContext.ownerType,
        ownerId: selectedContext.ownerId,
        q: submittedQuery,
        cursor,
      });
      const response = await fetch(`/invoices?${params}`, {
        credentials: "same-origin",
      });
      if (!isCurrent()) return;
      if (response.status === 401) {
        setExpired(true);
        unauthorized();
        return;
      }
      if (!response.ok) throw new InvoiceReadError(response.status);
      const result = (await response.json()) as {
        invoices: InvoiceListItem[];
        nextCursor: string | null;
      };
      if (!isCurrent()) return;
      setListState((current) => {
        if (
          current.kind !== "loaded" ||
          current.contextKey !== contextKey ||
          current.nextCursor !== cursor
        ) {
          return current;
        }

        const invoices = [...current.invoices, ...result.invoices].filter(
          (invoice, index, all) =>
            all.findIndex(
              (candidate) => candidate.invoiceId === invoice.invoiceId,
            ) === index,
        );
        return {
          kind: "loaded",
          contextKey,
          invoices,
          nextCursor: result.nextCursor,
        };
      });
    } catch (error: unknown) {
      if (!isCurrent()) return;
      setPageError(error instanceof InvoiceReadError ? error.status : 0);
    } finally {
      if (isCurrent()) {
        pageRequest.current = null;
        setIsLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    if (!detailId || !selectedContext) return;
    let cancelled = false;
    const key = `${contextValue(selectedContext)}:${detailId}`;
    const observed = get(key);
    setDetailState({ kind: "loading" });
    const params = new URLSearchParams({
      organizationId: selectedContext.organizationId,
      ownerType: selectedContext.ownerType,
      ownerId: selectedContext.ownerId,
    });
    void fetch(`/invoices/${encodeURIComponent(detailId)}?${params}`, {
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (response.status === 401) {
          if (!cancelled) {
            setExpired(true);
            unauthorized();
          }
          return null;
        }
        if (!response.ok) throw new InvoiceReadError(response.status);
        const result = (await response.json()) as {
          invoice: InvoiceDetail;
          auditEvents: AuditEvent[];
        };
        if (result.invoice.invoiceId !== detailId)
          throw new Error("Invoice detail identity mismatch");
        return result;
      })
      .then((result) => {
        if (!cancelled && result) {
          setDetailState({ kind: "loaded", ...result });
          reconcile(key, observed);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setDetailState({
            kind: "error",
            status:
              error instanceof InvoiceReadError ? error.status : undefined,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [
    detailId,
    detailReloadKey,
    get,
    reconcile,
    unauthorized,
    selectedContext?.organizationId,
    selectedContext?.ownerId,
    selectedContext?.ownerType,
  ]);

  const decide = async (
    input:
      | { mode: "RULE_V1" }
      | { mode: "PROBABILITY_POLICY"; policyVersion: string },
  ) => {
    if (!detailId || !selectedContext) return;
    const params = new URLSearchParams({
      organizationId: selectedContext.organizationId,
      ownerType: selectedContext.ownerType,
      ownerId: selectedContext.ownerId,
    });
    await execute(
      decisionKey,
      detailId,
      `/invoices/${encodeURIComponent(detailId)}/decision?${params}`,
      input,
    );
  };

  const displayedDetail =
    detailState.kind === "loaded" &&
    operation?.kind === "completed" &&
    operation.result.invoice.invoiceId === detailState.invoice.invoiceId
      ? {
          ...detailState,
          invoice: { ...detailState.invoice, ...operation.result.invoice },
          auditEvents: [
            operation.result.auditEvent,
            ...detailState.auditEvents.filter(
              (event) =>
                event.correlationId !==
                operation.result.auditEvent.correlationId,
            ),
          ],
        }
      : detailState;

  if (expired)
    return <p role="alert">La sesión expiró. Inicia sesión nuevamente.</p>;

  if (availableContexts.length === 0) {
    return (
      <section aria-labelledby="invoices-title">
        <h2 id="invoices-title">Facturas</h2>
        <p>No tienes organizaciones para consultar facturas.</p>
      </section>
    );
  }
  if (detailId) {
    return (
      <section
        aria-labelledby="invoice-detail-title"
        className="workspace-content space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4"
      >
        <button
          type="button"
          onClick={() => {
            setDetailId(undefined);
          }}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
        >
          Volver a facturas
        </button>
        {detailState.kind === "loading" ? (
          <p role="status">Cargando factura...</p>
        ) : null}
        {detailState.kind === "error" ? (
          <>
            <p role="alert">No fue posible cargar la factura.</p>
            <p>{invoiceHttpMessage(detailState.status)}</p>
            <button
              type="button"
              onClick={() => setDetailReloadKey((value) => value + 1)}
            >
              Reintentar factura
            </button>
          </>
        ) : null}
        {operation?.kind === "unknown" ? (
          <>
            <p role="alert">
              El resultado es desconocido. Consulta el estado antes de volver a
              decidir; salir de la pantalla no cancela la operación.{" "}
              {invoiceHttpMessage(operation.status)}
            </p>
            <button
              type="button"
              onClick={() => setDetailReloadKey((value) => value + 1)}
            >
              Consultar estado de la decisión
            </button>
          </>
        ) : null}
        {displayedDetail.kind === "loaded" ? (
          <InvoiceDetailView
            detail={displayedDetail}
            fresh={operation?.kind === "completed"}
            evaluationOpen={evaluationOpen}
            onEvaluationChange={setEvaluationOpen}
            deciding={operation?.kind === "pending"}
            blocked={operation?.kind === "unknown"}
            onDecide={decide}
            policyVersion={policyVersion}
            onPolicyVersionChange={setPolicyVersion}
          />
        ) : null}
      </section>
    );
  }
  return (
    <section
      aria-labelledby="invoices-title"
      className="workspace-content space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 id="invoices-title">Facturas</h2>
        <p className="text-sm font-medium text-slate-600">
          {selectedContext?.organizationName} ·{" "}
          {selectedContext?.ownerType === "user"
            ? "Trabajo individual"
            : `Grupo: ${selectedContext?.ownerName}`}
        </p>
      </div>
      <label className="grid gap-1 font-semibold">
        Propietario
        <select
          ref={ownerSelectorRef}
          className="w-full rounded border border-slate-300 bg-white p-2 text-slate-900 sm:max-w-md"
          value={selectedValue}
          onChange={(event) => {
            setSelectedValue(event.target.value);
            setDetailId(undefined);
          }}
        >
          <option value="" disabled>
            Selecciona un propietario
          </option>
          {availableContexts.map((context) => (
            <option key={contextValue(context)} value={contextValue(context)}>
              {context.organizationName} ·{" "}
              {context.ownerType === "user"
                ? "Individual"
                : `Grupo: ${context.ownerName}`}
            </option>
          ))}
        </select>
      </label>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim().length <= 120) setSubmittedQuery(query.trim());
        }}
      >
        <label className="grid flex-1 gap-1 font-semibold">
          Buscar por ID o proveedor
          <input
            className="rounded border border-slate-300 p-2"
            value={query}
            maxLength={120}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-2 font-semibold text-white sm:self-end"
        >
          Buscar
        </button>
      </form>
      {listState.kind === "loading" ? (
        <p role="status">Cargando facturas...</p>
      ) : null}
      {listState.kind === "error" ? (
        <>
          <p role="alert">
            No fue posible cargar las facturas.{" "}
            {invoiceHttpMessage(listState.status)}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Reintentar facturas
          </button>
        </>
      ) : null}
      {listState.kind === "loaded" && listState.invoices.length === 0 ? (
        <p>No hay facturas para este propietario.</p>
      ) : null}
      {listState.kind === "loaded" && listState.invoices.length > 0 ? (
        <>
          <div
            className="workspace-table-scroll"
            role="region"
            aria-label="Listado de facturas"
            tabIndex={0}
          >
            <table className="invoice-table text-left text-sm">
              <thead>
                <tr className="border-b border-slate-300">
                  <th>ID</th>
                  <th>Proveedor</th>
                  <th>Monto (CLP)</th>
                  <th>Orden de compra</th>
                  <th>Cotejo de tres vías</th>
                  <th>Estado</th>
                  <th>
                    <span className="sr-only">Detalle</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {listState.invoices.map((invoice) => (
                  <tr
                    key={invoice.invoiceId}
                    className="border-b border-slate-200"
                  >
                    <td>{invoice.invoiceId}</td>
                    <td>{invoice.vendorName}</td>
                    <td>{money(invoice.invoiceAmountCents)}</td>
                    <td>{yesNo(invoice.hasPurchaseOrder)}</td>
                    <td>{yesNo(invoice.threeWayMatch)}</td>
                    <td>
                      {(() => {
                        const decision = get(
                          `${selectedValue}:${invoice.invoiceId}`,
                        );
                        return invoiceLabel(
                          decision?.kind === "completed"
                            ? decision.result.invoice.status
                            : invoice.status,
                        );
                      })()}
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => {
                          setDetailState({ kind: "loading" });
                          setEvaluationOpen(false);
                          setPolicyVersion("");
                          setDetailId(invoice.invoiceId);
                        }}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-800"
                      >
                        Ver {invoice.invoiceId}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageError !== null ? (
            <p role="alert">
              No fue posible cargar la siguiente página.{" "}
              {invoiceHttpMessage(pageError)} Las facturas cargadas se
              conservan.
            </p>
          ) : null}
          {listState.nextCursor ? (
            <button
              type="button"
              disabled={isLoadingMore}
              onClick={() => void loadMore()}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 font-semibold text-slate-800"
            >
              {isLoadingMore ? "Cargando más..." : "Cargar más"}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function InvoiceDetailView({
  detail,
  fresh,
  evaluationOpen,
  onEvaluationChange,
  deciding,
  blocked,
  onDecide,
  policyVersion,
  onPolicyVersionChange,
}: {
  detail: Extract<DetailState, { kind: "loaded" }>;
  fresh: boolean;
  evaluationOpen: boolean;
  onEvaluationChange: (value: boolean) => void;
  deciding: boolean;
  blocked: boolean;
  onDecide: (
    input:
      | { mode: "RULE_V1" }
      | { mode: "PROBABILITY_POLICY"; policyVersion: string },
  ) => void;
  policyVersion: string;
  onPolicyVersionChange: (value: string) => void;
}) {
  const { invoice, auditEvents } = detail;
  return (
    <>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Detalle de factura
          </p>
          <h2 id="invoice-detail-title">{invoice.invoiceId}</h2>
        </div>
        <strong>{invoiceLabel(invoice.status)}</strong>
      </div>
      <div className="action-row" role="group" aria-label="Vistas de factura">
        <button
          type="button"
          aria-pressed={!evaluationOpen}
          onClick={() => onEvaluationChange(false)}
        >
          Detalle de factura
        </button>
        <button
          type="button"
          aria-pressed={evaluationOpen}
          onClick={() => onEvaluationChange(true)}
        >
          Evaluación ML
        </button>
      </div>
      {!evaluationOpen ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <p>
              <strong>Proveedor:</strong> {invoice.vendorName}
            </p>
            <p>
              <strong>Monto (CLP):</strong> {money(invoice.invoiceAmountCents)}
            </p>
            <p>
              <strong>Orden de compra:</strong>{" "}
              {yesNo(invoice.hasPurchaseOrder)}
            </p>
            <p>
              <strong>Cotejo de tres vías:</strong>{" "}
              {yesNo(invoice.threeWayMatch)}
            </p>
            <p>
              <strong>Creada:</strong> {invoiceDate(invoice.createdAt)}
            </p>
            <p>
              <strong>Actualizada:</strong> {invoiceDate(invoice.updatedAt)}
            </p>
          </div>
          <section aria-labelledby="risk-title">
            <h3 id="risk-title">Contexto de riesgo</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <p>
                Antigüedad proveedor: {invoice.riskContext.vendorTenureDays}{" "}
                días
              </p>
              <p>
                Incidentes en los últimos 12 meses:{" "}
                {invoice.riskContext.previousIncidents12m}
              </p>
              <p>
                Cambio reciente de cuenta bancaria:{" "}
                {yesNo(invoice.riskContext.bankAccountRecentlyChanged)}
              </p>
              <p>
                Monto respecto de la mediana del proveedor:{" "}
                {invoiceNumber(invoice.riskContext.amountVsVendorMedian)} veces
              </p>
              <p>
                Riesgo país: {invoiceLabel(invoice.riskContext.countryRisk)}
              </p>
            </div>
          </section>
        </>
      ) : null}
      <EvaluationScreen
        invoice={invoice}
        event={auditEvents[0]}
        fresh={fresh}
        expanded={evaluationOpen}
        deciding={deciding}
        blocked={blocked}
        onDecide={onDecide}
        policyVersion={policyVersion}
        onPolicyVersionChange={onPolicyVersionChange}
      />
      {!evaluationOpen ? <InvoiceAuditHistory events={auditEvents} /> : null}
    </>
  );
}
