import { useEffect, useRef, useState } from "react";

import "./tailwind.css";
import { contextValue, useWorkspace } from "../workspace/WorkspaceContext";
import { useUnauthorized } from "../auth/components/ProtectedSession";
import {
  invoiceMoney as money,
  invoiceLabel,
  invoiceCivilDate,
  invoiceDate,
  invoiceHttpMessage,
} from "./invoicePresentation";
import { protectedFetch } from "../auth/api/protectedFetch";

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
  id: string;
  businessId: string;
  organizationId: string;
  groupId: string;
  supplierName: string;
  amountPesos: number;
  currency: string;
  issuedOn: string;
  dueOn: string;
  businessStatus: string;
  processingStatus: string;
  createdByUserId: string;
  createdAt: string;
};
export type InvoiceDetail = InvoiceListItem;
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
  | { kind: "loaded"; invoice: InvoiceDetail };

class InvoiceReadError extends Error {
  constructor(readonly status: number) {
    super("Invoice read failed");
  }
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
  const [detailReloadKey, setDetailReloadKey] = useState(0);

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
    void protectedFetch(`/api/v1/invoices?${params}`, {
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
      const response = await protectedFetch(`/api/v1/invoices?${params}`, {
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
            all.findIndex((candidate) => candidate.id === invoice.id) === index,
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
    setDetailState({ kind: "loading" });
    const params = new URLSearchParams({
      organizationId: selectedContext.organizationId,
      ownerType: selectedContext.ownerType,
      ownerId: selectedContext.ownerId,
    });
    void protectedFetch(
      `/api/v1/invoices/${encodeURIComponent(detailId)}?${params}`,
      {
        credentials: "same-origin",
      },
    )
      .then(async (response) => {
        if (response.status === 401) {
          if (!cancelled) {
            setExpired(true);
            unauthorized();
          }
          return null;
        }
        if (!response.ok) throw new InvoiceReadError(response.status);
        const result = (await response.json()) as { invoice: InvoiceDetail };
        if (result.invoice.id !== detailId)
          throw new Error("Invoice detail identity mismatch");
        return result;
      })
      .then((result) => {
        if (!cancelled && result) setDetailState({ kind: "loaded", ...result });
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
    unauthorized,
    selectedContext?.organizationId,
    selectedContext?.ownerId,
    selectedContext?.ownerType,
  ]);

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
        className="workspace-content space-y-4 rounded-lg border border-(--color-border) bg-(--color-surface-muted) p-4"
      >
        <button
          type="button"
          onClick={() => {
            setDetailId(undefined);
          }}
          className="rounded-md border border-(--color-border-strong) bg-(--color-surface) px-3 py-2 text-sm font-semibold text-(--color-text)"
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
        {detailState.kind === "loaded" ? (
          <InvoiceDetailView detail={detailState} />
        ) : null}
      </section>
    );
  }
  return (
    <section
      aria-labelledby="invoices-title"
      className="workspace-content space-y-4 rounded-lg border border-(--color-border) bg-(--color-surface-muted) p-4"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 id="invoices-title">Facturas</h2>
        <p className="text-sm font-medium text-(--color-text-muted)">
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
          className="w-full rounded border border-(--color-border-strong) bg-(--color-surface) p-2 text-(--color-text) sm:max-w-md"
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
            className="rounded border border-(--color-border-strong) p-2"
            value={query}
            maxLength={120}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-(--color-primary) px-3 py-2 font-semibold text-(--color-on-primary) sm:self-end"
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
                <tr className="border-b border-(--color-border-strong)">
                  <th>ID comercial</th>
                  <th>Proveedor</th>
                  <th>Monto (CLP)</th>
                  <th>Emisión</th>
                  <th>Vencimiento</th>
                  <th>Estado</th>
                  <th>Procesamiento</th>
                  <th>
                    <span className="visually-hidden">Detalle</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {listState.invoices.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className="border-b border-(--color-border)"
                  >
                    <td>{invoice.businessId}</td>
                    <td>{invoice.supplierName}</td>
                    <td>{money(invoice.amountPesos)}</td>
                    <td>{invoiceCivilDate(invoice.issuedOn)}</td>
                    <td>{invoiceCivilDate(invoice.dueOn)}</td>
                    <td>{invoiceLabel(invoice.businessStatus)}</td>
                    <td>{invoiceLabel(invoice.processingStatus)}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => {
                          setDetailState({ kind: "loading" });
                          setDetailId(invoice.id);
                        }}
                        className="rounded-md border border-(--color-border-strong) bg-(--color-surface) px-2 py-1 font-semibold text-(--color-text)"
                      >
                        Ver {invoice.businessId}
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
              className="rounded-md border border-(--color-border-strong) bg-(--color-surface) px-3 py-2 font-semibold text-(--color-text)"
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
}: {
  detail: Extract<DetailState, { kind: "loaded" }>;
}) {
  const { invoice } = detail;
  return (
    <>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-(--color-text-muted)">
            Detalle de factura
          </p>
          <h2 id="invoice-detail-title">{invoice.businessId}</h2>
        </div>
        <strong>{invoiceLabel(invoice.businessStatus)}</strong>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <p>
          <strong>Proveedor:</strong> {invoice.supplierName}
        </p>
        <p>
          <strong>Monto (CLP):</strong> {money(invoice.amountPesos)}
        </p>
        <p>
          <strong>Emisión:</strong> {invoiceCivilDate(invoice.issuedOn)}
        </p>
        <p>
          <strong>Vencimiento:</strong> {invoiceCivilDate(invoice.dueOn)}
        </p>
        <p>
          <strong>Procesamiento:</strong>{" "}
          {invoiceLabel(invoice.processingStatus)}
        </p>
        <p>
          <strong>Creada:</strong> {invoiceDate(invoice.createdAt)}
        </p>
      </div>
    </>
  );
}
