import { useId, useState } from "react";

import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import { MAX_PAGE_SIZE } from "../../../lib/pagination";
import { useOrganizationsPageQuery } from "../../orgs/hooks/useOrganizations";
import { organizationOptionLabel, type OrganizationOption } from "./draft";

const SEARCH_DELAY_MS = 300;

/**
 * Picks the organization of one card. The preloaded options are the first
 * page of the platform list; when there are more organizations than that, a
 * search box queries the server (`GET /organizations?search=`) so any of them
 * can be found and chosen, not only those of the first page. It sits inside
 * the wizard's form, so it is a plain input (never a nested form) and Enter
 * does not submit the wizard.
 */
export function OrganizationPicker({
  value,
  current,
  options,
  total,
  taken,
  disabled,
  invalid,
  describedBy,
  onPick,
}: {
  /** The chosen organization id, "" until one is chosen. */
  value: string;
  /** The chosen organization as known when it was picked. */
  current: OrganizationOption | undefined;
  /** The preloaded first page. */
  options: OrganizationOption[];
  /** How many organizations exist in all. */
  total: number;
  /** Organizations already chosen by the other cards. */
  taken: ReadonlySet<string>;
  disabled: boolean;
  invalid: boolean;
  describedBy: string;
  onPick: (option: OrganizationOption | undefined) => void;
}) {
  const searchId = useId();
  const hintId = useId();
  const [text, setText] = useState("");
  const search = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const searchable = total > options.length;
  const searching = searchable && search !== "";
  const results = useOrganizationsPageQuery(
    { search, page: 1, pageSize: MAX_PAGE_SIZE },
    searching,
  );
  const listed = searching ? (results.data?.organizations ?? []) : options;
  const listedTotal = searching ? (results.data?.total ?? 0) : total;
  const choices = listed.filter(({ id }) => id === value || !taken.has(id));
  // The chosen organization stays selectable even when the search left it out.
  if (current && value && !choices.some(({ id }) => id === value))
    choices.unshift(current);

  return (
    <>
      {searchable ? (
        <>
          <label htmlFor={searchId}>Buscar organización</label>
          <input
            id={searchId}
            type="search"
            value={text}
            disabled={disabled}
            aria-describedby={hintId}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter must not submit the wizard from here.
              if (event.key === "Enter") event.preventDefault();
            }}
          />
          <p id={hintId} className="field-hint" role="status">
            {searching && results.isError
              ? "No fue posible buscar organizaciones. Intenta nuevamente."
              : searching && (results.isFetching || text.trim() !== search)
                ? "Buscando organizaciones..."
                : searching && listed.length === 0
                  ? "Ninguna organización coincide con la búsqueda."
                  : listedTotal > listed.length
                    ? `Mostrando ${listed.length} de ${listedTotal} organizaciones. Escribe parte del nombre para encontrar otra.`
                    : `${listedTotal} organizaciones.`}
          </p>
        </>
      ) : null}
      <label>
        Organización
        <select
          value={value}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) =>
            onPick(choices.find(({ id }) => id === event.target.value))
          }
        >
          <option value="">Selecciona una organización</option>
          {choices.map((option) => (
            <option key={option.id} value={option.id}>
              {organizationOptionLabel(option)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
