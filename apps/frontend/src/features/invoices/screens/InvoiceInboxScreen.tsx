import { ReceiptText, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { EmptyState } from "../../../components/EmptyState";
import { PageHeader } from "../../../components/PageHeader";
import { PaginationControls } from "../../../components/PaginationControls";
import { Toast } from "../../../components/Toast";
import { isApiError } from "../../auth/api/apiError";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { useRouteNotice } from "../../navigation/useRouteNotice";
import { useOutOfRangeRedirect } from "../../navigation/useListParams";
import {
  InvoiceFilterBar,
  type FilterChange,
  type FilterChangeOptions,
} from "../components/InvoiceFilterBar";
import { InvoiceTable, InvoiceTableSkeleton } from "../components/InvoiceTable";
import { useInvoiceScopeOptions } from "../hooks/useInvoiceScopeOptions";
import { useInvoicesQuery } from "../hooks/useInvoices";
import {
  hasActiveFilters,
  hasInvertedRange,
  INVOICE_PAGE_SIZE,
  invoiceFiltersFromSearch,
  invoiceSearch,
} from "../invoiceFilters";
import { invoiceCountText, invoiceRangeText } from "../invoicePresentation";
import {
  invoiceScopeValue,
  resolveInvoiceScope,
  scopeFromSearch,
  type InvoiceScopeOption,
} from "../invoiceScopes";
import type { InvoiceFilters, InvoiceScope } from "../types";

function listErrorText(error: unknown, forbidden: boolean) {
  if (forbidden)
    return "Ya no tienes permiso para ver estas facturas. Estamos actualizando tus permisos.";
  if (isApiError(error) && error.status === 400)
    return "Los filtros elegidos no son válidos. Cámbialos e intenta nuevamente.";
  return "No fue posible cargar las facturas.";
}

/**
 * The inbox of one scope: header with count and refresh, filter toolbar and
 * the page of rows. Its state is the Query entry's; the filters are the URL's.
 */
function InvoiceInbox({
  options,
  selected,
  filters,
}: {
  options: readonly InvoiceScopeOption[];
  selected: InvoiceScopeOption;
  filters: InvoiceFilters;
}) {
  const navigate = useNavigate();
  const scope = selected.context;
  const inverted = hasInvertedRange(filters);
  // An inverted range is never sent: the API would refuse it.
  const { query, failed, error, forbidden } = useInvoicesQuery(scope, filters, {
    enabled: !inverted,
  });
  // After a 403 nothing the entry still holds is shown. While the next page of
  // this scope loads, `data` is the previous one (a placeholder): it keeps the
  // footer and the focus in place but is neither "settled" nor an answer.
  const page = forbidden ? undefined : query.data;
  const stale = query.isPlaceholderData;
  const go = (
    target: InvoiceScope,
    next: InvoiceFilters,
    { replace = false }: FilterChangeOptions = {},
  ) => navigate(paths.invoicesWith(invoiceSearch(target, next)), { replace });
  const toPage = (next: number) =>
    paths.invoicesWith(invoiceSearch(scope, { ...filters, page: next }));
  const outOfRange = useOutOfRangeRedirect(
    {
      page: filters.page,
      pageSize: page?.pageSize || INVOICE_PAGE_SIZE,
      total: page?.total,
      rowCount: page?.items.length ?? 0,
      settled: page !== undefined && !stale,
    },
    toPage,
  );
  // «Limpiar filtros» also empties search text that was typed, not submitted.
  // The search box takes the focus the vanished button leaves behind, except
  // after a touch tap: focusing a text field there would raise the virtual
  // keyboard, so the scope selector (stable, no keyboard) takes it instead.
  const [clearCount, setClearCount] = useState(0);
  const [focusSearch, setFocusSearch] = useState(true);
  const clear = (event: MouseEvent<HTMLButtonElement>) => {
    const { pointerType } = event.nativeEvent as PointerEvent;
    setFocusSearch(pointerType !== "touch");
    setClearCount((count) => count + 1);
    go(scope, { q: "", page: 1 });
  };
  const filtered = hasActiveFilters(filters);

  // A failed page unmounts the footer the focus was in; the alert's
  // «Reintentar» is where it lands, but only when the focus was really lost
  // there (a person who moved on elsewhere keeps their place).
  const retry = useRef<HTMLButtonElement>(null);
  const footerHadFocus = useRef(false);
  // While a retry runs the entry is «pending» again but `failed` still holds
  // (derived from the entry), so the alert and its focused button stay.
  const failedWithoutRows = failed && page === undefined;
  const footerShown = page !== undefined && page.total > 0;
  useEffect(() => {
    if (!failedWithoutRows || !footerHadFocus.current) return;
    footerHadFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) retry.current?.focus();
  }, [failedWithoutRows, query.errorUpdatedAt]);
  // A footer that went away for any other reason takes its focus with it: the
  // flag must not survive to steal the focus on a later, unrelated failure.
  useEffect(() => {
    if (!footerShown && !failedWithoutRows) footerHadFocus.current = false;
  }, [footerShown, failedWithoutRows]);
  // aria-disabled keeps the focus: the click is ignored while a fetch runs.
  const retryList = () => {
    if (query.isFetching) return;
    void query.refetch();
  };
  // What the rows on screen are: the previous page's while the next loads.
  const loadingRows =
    (page === undefined && query.isPending && !failed) ||
    (stale && page?.items.length === 0);
  const countText = stale
    ? "Actualizando…"
    : page
      ? invoiceCountText(page.total)
      : "";

  return (
    <>
      <PageHeader
        title="Facturas"
        description={selected.summary}
        action={
          inverted ? undefined : (
            <div className="inbox-header-actions">
              <p className="inbox-count" role="status">
                {countText}
              </p>
              <button
                type="button"
                className="secondary-button button-with-icon"
                aria-disabled={query.isFetching || undefined}
                aria-busy={query.isFetching}
                onClick={() => {
                  // aria-disabled keeps the focus: the click is ignored here.
                  if (!query.isFetching) void query.refetch();
                }}
              >
                <RefreshCw
                  aria-hidden="true"
                  focusable="false"
                  size={16}
                  className={query.isFetching ? "icon-spin" : undefined}
                />
                Actualizar
              </button>
            </div>
          )
        }
      />
      <InvoiceFilterBar
        options={options}
        selected={selected}
        filters={filters}
        onScopeChange={(option) => go(option.context, { ...filters, page: 1 })}
        onFilterChange={(change: FilterChange, options?: FilterChangeOptions) =>
          go(scope, { ...filters, ...change, page: 1 }, options)
        }
        onClear={clear}
        searchKey={clearCount}
        focusSearch={focusSearch}
      />
      {inverted ? (
        <p role="alert" className="inbox-alert">
          La fecha «Desde» no puede ser posterior a «Hasta».
        </p>
      ) : (
        <>
          {failed ? (
            <div className="inbox-alert">
              <p role="alert">
                {page !== undefined
                  ? "No fue posible actualizar las facturas; lo que ves puede estar desactualizado."
                  : listErrorText(error, forbidden)}
              </p>
              <button
                ref={retry}
                type="button"
                className="secondary-button"
                aria-disabled={query.isFetching || undefined}
                onClick={retryList}
              >
                {query.isFetching ? "Reintentando…" : "Reintentar"}
              </button>
            </div>
          ) : null}
          {/* Mounted before it speaks: a region inserted with its text is not
              reliably announced. */}
          <p role="status" className="visually-hidden">
            {loadingRows ? "Cargando facturas…" : ""}
          </p>
          {loadingRows ? (
            <div aria-busy="true">
              <InvoiceTableSkeleton />
            </div>
          ) : null}
          {page && !stale && page.items.length === 0 && !outOfRange ? (
            filtered ? (
              <EmptyState
                compact
                icon={ReceiptText}
                title="Ninguna factura coincide con los filtros"
                description="Prueba con otros filtros o quítalos para ver todas las facturas."
                action={
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={clear}
                  >
                    Limpiar filtros
                  </button>
                }
              />
            ) : (
              <EmptyState
                compact
                icon={ReceiptText}
                title={`Todavía no hay facturas en ${selected.place}`}
                description="Cuando se registren facturas aparecerán aquí. Puedes elegir otro alcance en «Ver facturas de»."
              />
            )
          ) : null}
          {page && page.items.length > 0 ? (
            <InvoiceTable
              invoices={page.items}
              inboxSearch={invoiceSearch(scope, filters)}
              busy={stale}
            />
          ) : null}
          {page && page.total > 0 ? (
            <div
              className="inbox-footer"
              onFocus={() => {
                footerHadFocus.current = true;
              }}
              onBlur={() => {
                footerHadFocus.current = false;
              }}
            >
              {page.items.length > 0 && !stale ? (
                <p className="muted">
                  {invoiceRangeText(
                    filters.page,
                    page.pageSize || INVOICE_PAGE_SIZE,
                    page.total,
                    page.items.length,
                  )}
                </p>
              ) : null}
              <PaginationControls
                page={stale ? page.page : filters.page}
                pageSize={page.pageSize || INVOICE_PAGE_SIZE}
                total={page.total}
                busy={stale}
                onPageChange={(next) => navigate(toPage(next))}
              />
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * The inbox screen: the scopes the profile allows, filters and page in the
 * URL, and the list of the chosen scope. Without a readable scope nothing is
 * asked.
 */
export function InvoiceInboxScreen({ profile }: { profile: Profile }) {
  const [params] = useSearchParams();
  const notice = useRouteNotice();
  const {
    options,
    loadingOrganizationIds,
    groupsFailed,
    groupsFetching,
    retryGroups,
  } = useInvoiceScopeOptions(profile);
  const selected = resolveInvoiceScope(options, params);
  // A URL naming a group the profile does not list may still be readable by an
  // organization-wide reader: wait for the organization's groups instead of
  // listing another scope under that URL.
  const requested = scopeFromSearch(params);
  const awaitingGroups =
    requested?.kind === "group" &&
    loadingOrganizationIds.includes(requested.organizationId) &&
    !options.some(({ value }) => value === invoiceScopeValue(requested));
  const filters = invoiceFiltersFromSearch(params);

  return (
    <div className="screen-stack screen-fill">
      <Toast message={notice.message} noticeId={notice.id} />
      {/* The status region stays mounted and only its content changes. */}
      <div role="status" className="groups-status">
        {groupsFailed ? (
          <div className="inbox-alert">
            <p>
              No fue posible cargar todos los grupos de tu organización. Solo
              ves los que ya conocemos.
            </p>
            <button
              type="button"
              className="secondary-button"
              aria-disabled={groupsFetching || undefined}
              onClick={() => {
                // aria-disabled keeps the focus: the click is ignored here.
                if (!groupsFetching) retryGroups();
              }}
            >
              Reintentar
            </button>
          </div>
        ) : null}
      </div>
      {awaitingGroups ? (
        <>
          <PageHeader title="Facturas" />
          <p role="status">Cargando facturas…</p>
        </>
      ) : selected === undefined ? (
        <>
          <PageHeader title="Facturas" />
          <EmptyState
            compact
            icon={ReceiptText}
            title="Aún no puedes ver facturas"
            description="Pide a un administrador de tu organización que te dé acceso a las facturas de la organización o de un grupo."
          />
        </>
      ) : (
        <InvoiceInbox options={options} selected={selected} filters={filters} />
      )}
    </div>
  );
}
