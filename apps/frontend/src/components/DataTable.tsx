import type { ReactNode } from "react";

import { useScrollsHorizontally } from "./useScrollsHorizontally";

export interface DataColumn<Row> {
  header: string;
  /** Extra class of the column's header and cells (alignment, weight). */
  className?: string;
  cell: (row: Row) => ReactNode;
}

/**
 * Read-only table of rows (no selection). Same markup rules as
 * `SelectionTable`: below 40rem every row becomes a card whose cells show
 * their column name, so every element carries its role explicitly.
 */
export function DataTable<Row extends { id: string }>({
  label,
  rows,
  columns,
  className,
  busy = false,
}: {
  /** Accessible name of the table; its scroll region is «Tabla de …». */
  label: string;
  rows: readonly Row[];
  columns: ReadonlyArray<DataColumn<Row>>;
  /** Extra class of the table, to style one table apart. */
  className?: string;
  /** The rows on screen are being replaced: announced as `aria-busy`. */
  busy?: boolean;
}) {
  // The scroll area is a region named apart from the table, and a tab stop
  // only while it overflows, so a keyboard user can scroll a table wider than
  // the screen without a useless stop otherwise.
  const { ref, scrolls } = useScrollsHorizontally<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className="workspace-table-scroll"
      role="region"
      aria-label={`Tabla de ${label}`}
      tabIndex={scrolls ? 0 : undefined}
    >
      <table
        className={className ? `data-table ${className}` : "data-table"}
        role="table"
        aria-label={label}
        aria-busy={busy || undefined}
      >
        <thead role="rowgroup">
          <tr role="row">
            {columns.map(({ header, className: columnClass }) => (
              <th
                key={header}
                scope="col"
                role="columnheader"
                className={columnClass}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={row.id} role="row">
              {columns.map(({ header, cell, className: columnClass }) => (
                <td
                  key={header}
                  role="cell"
                  data-label={header}
                  className={columnClass}
                >
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
