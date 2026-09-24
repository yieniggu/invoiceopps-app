import { useEffect, useState } from "react";

import "./tailwind.css";

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
type OwnerContext = {
  organizationId: string;
  organizationName: string;
  ownerType: "user" | "group";
  ownerId: string;
  ownerName: string;
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
type InvoiceDetail = InvoiceListItem & {
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
type AuditEvent = {
  decision: string;
  ruleVersion: string;
  mode: string;
  policyVersion: string | null;
  manualReviewThreshold: number | null;
  policyProbability: number | null;
  policyProbabilitySource: string | null;
  actor: { name: string; rut: string };
  correlationId: string;
  createdAt: string;
};
type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "loaded";
      contextKey: string;
      invoices: InvoiceListItem[];
      nextCursor: string | null;
    };
type DetailState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; invoice: InvoiceDetail; auditEvents: AuditEvent[] };

function contexts(profile: Profile, groups: Group[]): OwnerContext[] {
  return [
    ...profile.memberships.map(({ organization }) => ({
      organizationId: organization.id,
      organizationName: organization.name,
      ownerType: "user" as const,
      ownerId: profile.id,
      ownerName: "Trabajo individual",
    })),
    ...groups.map((group) => ({
      organizationId: group.organization.id,
      organizationName: group.organization.name,
      ownerType: "group" as const,
      ownerId: group.id,
      ownerName: group.name,
    })),
  ];
}

function contextValue(context: OwnerContext) {
  return `${context.organizationId}:${context.ownerType}:${context.ownerId}`;
}

function money(cents: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(cents / 100);
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
  const availableContexts = contexts(profile, groups);
  const [selectedValue, setSelectedValue] = useState(() =>
    availableContexts[0] ? contextValue(availableContexts[0]) : "",
  );
  const selectedContext = availableContexts.find(
    (context) => contextValue(context) === selectedValue,
  );
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [detailId, setDetailId] = useState<string>();
  const [detailState, setDetailState] = useState<DetailState>({
    kind: "loading",
  });
  const [isDeciding, setIsDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string>();
  const [policyVersion, setPolicyVersion] = useState("");

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
        if (!response.ok) throw new Error("Invoice list request failed");
        return (await response.json()) as {
          invoices: InvoiceListItem[];
          nextCursor: string | null;
        };
      })
      .then((result) => {
        if (!cancelled) setListState({ kind: "loaded", contextKey, ...result });
      })
      .catch(() => {
        if (!cancelled) setListState({ kind: "error" });
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
  ]);

  const loadMore = async () => {
    if (
      !selectedContext ||
      listState.kind !== "loaded" ||
      !listState.nextCursor
    ) {
      return;
    }

    const cursor = listState.nextCursor;
    const contextKey = `${contextValue(selectedContext)}:${submittedQuery}`;
    setIsLoadingMore(true);
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
      if (!response.ok) throw new Error("Invoice list request failed");
      const result = (await response.json()) as {
        invoices: InvoiceListItem[];
        nextCursor: string | null;
      };
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
    } catch {
      setListState((current) => {
        if (
          current.kind !== "loaded" ||
          current.contextKey !== contextKey ||
          current.nextCursor !== cursor
        ) {
          return current;
        }

        return { kind: "error" };
      });
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!detailId || !selectedContext) return;
    let cancelled = false;
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
        if (!response.ok) throw new Error("Invoice detail request failed");
        return (await response.json()) as {
          invoice: InvoiceDetail;
          auditEvents: AuditEvent[];
        };
      })
      .then((result) => {
        if (!cancelled) setDetailState({ kind: "loaded", ...result });
      })
      .catch(() => {
        if (!cancelled) setDetailState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [
    detailId,
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
    setIsDeciding(true);
    setDecisionError(undefined);
    try {
      const params = new URLSearchParams({
        organizationId: selectedContext.organizationId,
        ownerType: selectedContext.ownerType,
        ownerId: selectedContext.ownerId,
      });
      const response = await fetch(
        `/invoices/${encodeURIComponent(detailId)}/decision?${params}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw new Error("Invoice decision failed");
      const result = (await response.json()) as {
        invoice: { invoiceId: string; status: string; updatedAt: string };
        auditEvent: AuditEvent;
      };
      setDetailState((current) =>
        current.kind === "loaded"
          ? {
              kind: "loaded",
              invoice: {
                ...current.invoice,
                status: result.invoice.status,
                updatedAt: result.invoice.updatedAt,
              },
              auditEvents: [result.auditEvent, ...current.auditEvents],
            }
          : current,
      );
      setReloadKey((value) => value + 1);
    } catch {
      setDecisionError(
        "No fue posible registrar la decisión. Intenta nuevamente.",
      );
    } finally {
      setIsDeciding(false);
    }
  };

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
        className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4"
      >
        <button
          type="button"
          onClick={() => {
            setDetailId(undefined);
            setDecisionError(undefined);
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
            <button type="button" onClick={() => setDetailId(undefined)}>
              Volver a facturas
            </button>
          </>
        ) : null}
        {detailState.kind === "loaded" ? (
          <InvoiceDetailView
            detail={detailState}
            deciding={isDeciding}
            error={decisionError}
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
      className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4"
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
          className="w-full rounded border border-slate-300 bg-white p-2 text-slate-900 sm:max-w-md"
          value={selectedValue}
          onChange={(event) => {
            setSelectedValue(event.target.value);
            setDetailId(undefined);
          }}
        >
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
          setSubmittedQuery(query.trim());
        }}
      >
        <label className="grid flex-1 gap-1 font-semibold">
          Buscar por ID o proveedor
          <input
            className="rounded border border-slate-300 p-2"
            value={query}
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
          <p role="alert">No fue posible cargar las facturas.</p>
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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-300">
                  <th>ID</th>
                  <th>Proveedor</th>
                  <th>Monto</th>
                  <th>PO</th>
                  <th>Match</th>
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
                    <td>{invoice.status}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => setDetailId(invoice.invoiceId)}
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
          {listState.nextCursor ? (
            <button
              type="button"
              disabled={isLoadingMore}
              onClick={() => void loadMore()}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 font-semibold text-slate-800"
            >
              {isLoadingMore ? "Loading more..." : "Load more"}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function InvoiceDetailView({
  detail,
  deciding,
  error,
  onDecide,
  policyVersion,
  onPolicyVersionChange,
}: {
  detail: Extract<DetailState, { kind: "loaded" }>;
  deciding: boolean;
  error?: string;
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
        <strong>{invoice.status}</strong>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <p>
          <strong>Proveedor:</strong> {invoice.vendorName}
        </p>
        <p>
          <strong>Monto:</strong> {money(invoice.invoiceAmountCents)}
        </p>
        <p>
          <strong>Orden de compra:</strong> {yesNo(invoice.hasPurchaseOrder)}
        </p>
        <p>
          <strong>Three-way match:</strong> {yesNo(invoice.threeWayMatch)}
        </p>
      </div>
      <section aria-labelledby="risk-title">
        <h3 id="risk-title">Contexto de riesgo</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <p>
            Antigüedad proveedor: {invoice.riskContext.vendorTenureDays} días
          </p>
          <p>Incidentes previos: {invoice.riskContext.previousIncidents12m}</p>
          <p>
            Cambio de cuenta:{" "}
            {yesNo(invoice.riskContext.bankAccountRecentlyChanged)}
          </p>
          <p>Monto/mediana: {invoice.riskContext.amountVsVendorMedian}x</p>
          <p>Riesgo país: {invoice.riskContext.countryRisk}</p>
        </div>
      </section>
      {invoice.status === "PENDING" ? (
        <section aria-labelledby="decision-title">
          <h3 id="decision-title">Decisión</h3>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={deciding}
              onClick={() => void onDecide({ mode: "RULE_V1" })}
              className="rounded-md bg-slate-900 px-3 py-2 font-semibold text-white"
            >
              {deciding ? "Registrando decisión..." : "Aplicar Rule v1"}
            </button>
            <label className="grid gap-1 text-sm font-semibold">
              Versión de policy
              <input
                value={policyVersion}
                onChange={(event) => onPolicyVersionChange(event.target.value)}
                placeholder="ml-policy-v1"
              />
            </label>
            <button
              type="button"
              disabled={deciding || !policyVersion.trim()}
              onClick={() =>
                void onDecide({
                  mode: "PROBABILITY_POLICY",
                  policyVersion: policyVersion.trim(),
                })
              }
              className="rounded-md border border-slate-300 bg-white px-3 py-2 font-semibold text-slate-800"
            >
              Aplicar policy
            </button>
          </div>
          <p className="text-sm text-slate-600">
            Probabilidad: {invoice.policyProbability ?? "no declarada"} ·
            Fuente: {invoice.policyProbabilitySource ?? "no declarada"}
          </p>
          {error ? <p role="alert">{error}</p> : null}
        </section>
      ) : null}
      <section aria-labelledby="audit-title">
        <h3 id="audit-title">Eventos de auditoría</h3>
        {auditEvents.length === 0 ? (
          <p>No hay decisiones registradas.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Decisión</th>
                  <th>Regla</th>
                  <th>Modo</th>
                  <th>Policy</th>
                  <th>Probabilidad</th>
                  <th>Actor</th>
                  <th>Correlación</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((event) => (
                  <tr key={event.correlationId}>
                    <td>{event.createdAt}</td>
                    <td>{event.decision}</td>
                    <td>{event.ruleVersion}</td>
                    <td>{event.mode}</td>
                    <td>{event.policyVersion ?? "-"}</td>
                    <td>
                      {event.policyProbability ?? "-"}
                      {event.manualReviewThreshold !== null
                        ? ` / ${event.manualReviewThreshold}`
                        : ""}
                    </td>
                    <td>
                      {event.actor.name} ({event.actor.rut})
                    </td>
                    <td>{event.correlationId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
