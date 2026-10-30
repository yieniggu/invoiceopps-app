import { useEffect, useId, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { SearchForm } from "../../../components/SearchForm";
import {
  hasActiveFilters,
  isApplicableDate,
  isBelowMinimumDate,
  MAX_QUERY_LENGTH,
  MIN_FILTER_DATE,
} from "../invoiceFilters";
import type { InvoiceScopeOption } from "../invoiceScopes";
import {
  BUSINESS_STATUSES,
  type BusinessStatus,
  type InvoiceFilters,
} from "../types";

export type FilterChange = Partial<Omit<InvoiceFilters, "page">>;

/** `replace`: refine the current history entry instead of adding one. */
export interface FilterChangeOptions {
  replace?: boolean;
}

// Plurals are written out: the singular labels of `invoiceLabel` do not
// pluralise by adding an «s» in every case.
const STATUS_PLURALS: Record<BusinessStatus, string> = {
  PENDING: "Pendientes",
  APPROVED: "Aprobadas",
  REJECTED: "Rechazadas",
  CANCELLED: "Canceladas",
};

const STATUS_CHOICES: ReadonlyArray<{
  value: BusinessStatus | "";
  label: string;
}> = [
  { value: "", label: "Todas" },
  ...BUSINESS_STATUSES.map((status) => ({
    value: status,
    label: STATUS_PLURALS[status],
  })),
];

function ScopeOptions({ options }: { options: readonly InvoiceScopeOption[] }) {
  const organizations = [...new Set(options.map((o) => o.organizationId))];
  const render = ({ value, label }: InvoiceScopeOption) => (
    <option key={value} value={value}>
      {label}
    </option>
  );
  if (organizations.length === 1) {
    const groups = options.filter(({ context }) => context.kind === "group");
    return (
      <>
        {options.filter(({ context }) => context.kind !== "group").map(render)}
        {groups.length > 0 ? (
          <optgroup label="Grupos">{groups.map(render)}</optgroup>
        ) : null}
      </>
    );
  }
  return (
    <>
      {organizations.map((organizationId) => {
        const own = options.filter((o) => o.organizationId === organizationId);
        return (
          <optgroup key={organizationId} label={own[0]?.organizationName}>
            {own.map(render)}
          </optgroup>
        );
      })}
    </>
  );
}

/**
 * A date filter. Typing reports partial dates (a year of one to three digits),
 * so the box keeps its own text and the filter changes only when the text is
 * empty or a complete, valid date; the committed value adopts outside changes
 * (Back, a link) like `SearchForm`. An empty value that comes with
 * `validity.badInput` is a half-typed date (the browser reports "" for it),
 * not a cleared box: it only updates the draft. A complete date below the
 * minimum year is explained once the box loses the focus (not while the year
 * is still being typed, which passes through 0002…).
 */
function DateFilter({
  id,
  label,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [committed, setCommitted] = useState(value);
  const [belowMinimum, setBelowMinimum] = useState(false);
  if (value !== committed) {
    setCommitted(value);
    setDraft(value);
    setBelowMinimum(false);
  }
  const messageId = `${id}-message`;
  return (
    <div className="toolbar-date">
      <label htmlFor={id} className="toolbar-inline-label">
        <span>{label}</span>
        <input
          id={id}
          type="date"
          min={MIN_FILTER_DATE}
          value={draft}
          aria-describedby={belowMinimum ? messageId : undefined}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            setBelowMinimum(false);
            if (next === "") {
              if (!event.target.validity.badInput) onCommit(undefined);
            } else if (isApplicableDate(next)) onCommit(next);
          }}
          onBlur={() => setBelowMinimum(isBelowMinimumDate(draft))}
        />
      </label>
      {belowMinimum ? (
        <p id={messageId} role="alert" className="field-error">
          La fecha debe ser desde 1900.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Scope selector and filters in one toolbar. Everything shown is the URL's: a
 * change only asks the screen to navigate, and the page goes back to the
 * first. «Limpiar filtros» exists only while a filter is set and keeps the
 * scope.
 */
export function InvoiceFilterBar({
  options,
  selected,
  filters,
  onScopeChange,
  onFilterChange,
  onClear,
  searchKey,
  focusSearch,
}: {
  options: readonly InvoiceScopeOption[];
  selected: InvoiceScopeOption;
  filters: InvoiceFilters;
  onScopeChange: (option: InvoiceScopeOption) => void;
  onFilterChange: (change: FilterChange, options?: FilterChangeOptions) => void;
  onClear: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Changing it remounts the search box and the dates, dropping unsubmitted
   * drafts; the box takes the focus the cleared button leaves behind.
   */
  searchKey: number;
  /**
   * After a clear, whether the search box takes the focus (keyboard, mouse,
   * pen) or the scope selector does (touch: no virtual keyboard pops up).
   */
  focusSearch: boolean;
}) {
  const scopeId = useId();
  const statusName = useId();
  const fromId = useId();
  const toId = useId();
  const scopeSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (searchKey > 0 && !focusSearch) scopeSelect.current?.focus();
  }, [searchKey, focusSearch]);
  return (
    <div className="invoice-toolbar">
      <div className="toolbar-row">
        <div className="toolbar-field">
          <label htmlFor={scopeId} className="toolbar-label">
            Ver facturas de
          </label>
          <select
            ref={scopeSelect}
            id={scopeId}
            value={selected.value}
            onChange={(event) => {
              const next = options.find(
                ({ value }) => value === event.target.value,
              );
              if (next) onScopeChange(next);
            }}
          >
            <ScopeOptions options={options} />
          </select>
        </div>
        <div className="toolbar-field toolbar-grow">
          <SearchForm
            key={searchKey}
            autoFocus={searchKey > 0 && focusSearch}
            variant="toolbar"
            label="Buscar por número o proveedor"
            initial={filters.q}
            maxLength={MAX_QUERY_LENGTH}
            onSearch={(q) => onFilterChange({ q })}
          />
        </div>
        <fieldset className="toolbar-field toolbar-dates">
          <legend className="toolbar-label">Emisión</legend>
          <div className="toolbar-date-pair" key={searchKey}>
            <DateFilter
              id={fromId}
              label="Desde"
              value={filters.issuedFrom ?? ""}
              onCommit={(issuedFrom) =>
                onFilterChange({ issuedFrom }, { replace: true })
              }
            />
            <DateFilter
              id={toId}
              label="Hasta"
              value={filters.issuedTo ?? ""}
              onCommit={(issuedTo) =>
                onFilterChange({ issuedTo }, { replace: true })
              }
            />
          </div>
        </fieldset>
      </div>
      <div className="toolbar-row toolbar-row-status">
        <div
          role="radiogroup"
          aria-label="Estado de la factura"
          className="status-chips"
        >
          {STATUS_CHOICES.map(({ value, label }) => (
            <label key={label} className="status-chip">
              <input
                type="radio"
                name={statusName}
                value={value}
                checked={(filters.businessStatus ?? "") === value}
                onChange={() =>
                  onFilterChange({ businessStatus: value || undefined })
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {hasActiveFilters(filters) ? (
          <button type="button" className="text-button" onClick={onClear}>
            Limpiar filtros
          </button>
        ) : null}
      </div>
    </div>
  );
}
