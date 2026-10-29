import type { ReactNode } from "react";

export interface DataColumn<Row> {
  header: string;
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
}: {
  /** Accessible name of the table. */
  label: string;
  rows: readonly Row[];
  columns: ReadonlyArray<DataColumn<Row>>;
}) {
  return (
    <div className="workspace-table-scroll">
      <table className="data-table" role="table" aria-label={label}>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map(({ header }) => (
              <th key={header} scope="col" role="columnheader">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={row.id} role="row">
              {columns.map(({ header, cell }) => (
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
