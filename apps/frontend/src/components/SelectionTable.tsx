import { useEffect, useRef, type ReactNode } from "react";

import { useScrollsHorizontally } from "./useScrollsHorizontally";

export interface SelectionColumn<Row> {
  header: string;
  cell: (row: Row) => ReactNode;
}

/**
 * Table of people with a checkbox per row and a "Seleccionar todos" checkbox
 * in the header (indeterminate while only some rows are ticked). It is a real
 * table on wide screens; below 40rem every row becomes a card whose cells show
 * their column name (see `.data-table` in styles.css), so nothing scrolls
 * sideways. Below 40rem `display: block` makes some browsers (Safari) drop
 * the table semantics, so every element carries its role explicitly.
 * The scroll region is a tab stop only while it actually scrolls.
 */
export function SelectionTable<Row extends { id: string; name: string }>({
  label,
  rows,
  columns,
  isSelected,
  allSelected,
  someSelected,
  onToggle,
  onToggleAll,
  selectAllLabel = "Seleccionar todos",
}: {
  /** Accessible name of the table and its scroll region. */
  label: string;
  rows: readonly Row[];
  columns: ReadonlyArray<SelectionColumn<Row>>;
  isSelected: (id: string) => boolean;
  allSelected: boolean;
  someSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  /** Name of the header checkbox; a paginated list says which rows it means. */
  selectAllLabel?: string;
}) {
  const all = useRef<HTMLInputElement>(null);
  const { ref: region, scrolls } = useScrollsHorizontally<HTMLDivElement>();
  // `indeterminate` is a DOM property with no attribute: synchronise it.
  useEffect(() => {
    if (all.current) all.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <div
      ref={region}
      className="workspace-table-scroll"
      role="region"
      aria-label={label}
      tabIndex={scrolls ? 0 : undefined}
    >
      <table className="data-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader" className="select-column">
              {/* The label is visible on narrow screens, where the column
                  headers are hidden, and visually hidden otherwise. */}
              <label className="select-all">
                <input
                  ref={all}
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                />
                <span className="select-all-text">{selectAllLabel}</span>
              </label>
            </th>
            {columns.map(({ header }) => (
              <th key={header} scope="col" role="columnheader">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr
              key={row.id}
              role="row"
              className={isSelected(row.id) ? "is-selected" : undefined}
            >
              <td role="cell" className="select-column">
                <input
                  type="checkbox"
                  aria-label={`Seleccionar a ${row.name}`}
                  checked={isSelected(row.id)}
                  onChange={() => onToggle(row.id)}
                />
              </td>
              {columns.map(({ header, cell }) => (
                // `data-label` is the column name of the stacked layout.
                <td key={header} role="cell" data-label={header}>
                  {cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
