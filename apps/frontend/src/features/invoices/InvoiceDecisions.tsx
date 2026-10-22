import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AuditEvent } from "./InvoiceWorkspace";
import { useUnauthorized } from "../auth/ProtectedSession";

type DecisionResult = {
  invoice: { invoiceId: string; status: string; updatedAt: string };
  auditEvent: AuditEvent;
};
type Operation =
  | { kind: "pending" }
  | { kind: "unknown"; status?: number }
  | { kind: "completed"; result: DecisionResult };

function useLedger() {
  const unauthorized = useUnauthorized();
  const active = useRef(false);
  const operations = useRef(new Map<string, Operation>());
  const [, setVersion] = useState(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const publish = useCallback(
    (key: string, operation: Operation | undefined) => {
      if (!active.current) return;
      if (operation) operations.current.set(key, operation);
      else operations.current.delete(key);
      setVersion((value) => value + 1);
    },
    [],
  );
  const get = useCallback((key: string) => operations.current.get(key), []);
  const reconcile = useCallback(
    (key: string, observed: Operation | undefined) => {
      // Only a GET started after this terminal outcome can resolve uncertainty.
      if (
        observed?.kind === "unknown" &&
        operations.current.get(key) === observed
      )
        publish(key, undefined);
    },
    [publish],
  );
  const execute = async (
    key: string,
    invoiceId: string,
    path: string,
    input: unknown,
  ) => {
    if (!active.current || operations.current.has(key)) return;
    publish(key, { kind: "pending" });
    try {
      // Do not abort a mutation on navigation: aborting is not server cancellation.
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!active.current) return;
      if (response.status === 401) {
        publish(key, { kind: "unknown" });
        unauthorized();
        return;
      }
      if (!response.ok) {
        publish(key, { kind: "unknown", status: response.status });
        return;
      }
      const result = (await response.json()) as DecisionResult;
      if (!active.current) return;
      if (result.invoice.invoiceId !== invoiceId)
        throw new Error("Invoice decision identity mismatch");
      publish(key, { kind: "completed", result });
    } catch {
      publish(key, { kind: "unknown" });
    }
  };
  return { get, reconcile, execute };
}

const InvoiceDecisions = createContext<ReturnType<typeof useLedger> | null>(
  null,
);

export function InvoiceDecisionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const ledger = useLedger();
  return (
    <InvoiceDecisions.Provider value={ledger}>
      {children}
    </InvoiceDecisions.Provider>
  );
}

export function useInvoiceDecisions() {
  const shared = useContext(InvoiceDecisions);
  const local = useLedger();
  return shared ?? local;
}
