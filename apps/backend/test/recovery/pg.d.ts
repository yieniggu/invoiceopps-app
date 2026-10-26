// Minimal typing for the `pg` driver used by recovery PostgreSQL tests; avoids
// adding @types/pg as a new dependency.
declare module "pg" {
  export interface QueryResult {
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
  }
  export class Client {
    constructor(options: { connectionString: string });
    connect(): Promise<void>;
    end(): Promise<void>;
    query(sql: string, values?: unknown[]): Promise<QueryResult>;
  }
  const pg: { Client: typeof Client };
  export default pg;
}
