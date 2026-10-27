import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { protectedFetch } from "../auth/api/protectedFetch";

export type Policy = { version: string; manualReviewThreshold: number };
export type PolicyDraft = {
  selected?: string;
  version: string;
  threshold: string;
};
type Intent = { path: string; method: "POST" | "PATCH"; policy: Policy };
type OperationBase = { intent: Intent; draft: PolicyDraft };
type Operation = OperationBase &
  (
    | { kind: "pending" }
    | {
        kind: "unknown";
        confirmed: boolean;
        status?: number;
        checked?: boolean;
      }
    | { kind: "completed"; policy: Policy; source: "response" | "read" }
    | { kind: "rejected"; status?: number; preflight: boolean }
  );
const emptyDraft: PolicyDraft = { version: "", threshold: "" };

export class PolicyError extends Error {
  constructor(readonly status: number) {
    super("Policy request failed");
  }
}

export function parsePolicy(value: unknown): Policy {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    !("manualReviewThreshold" in value) ||
    typeof value.version !== "string" ||
    !value.version.trim() ||
    value.version.length > 120 ||
    typeof value.manualReviewThreshold !== "number" ||
    !Number.isFinite(value.manualReviewThreshold) ||
    value.manualReviewThreshold < 0 ||
    value.manualReviewThreshold > 1
  )
    throw new Error("Invalid policy response");
  return {
    version: value.version,
    manualReviewThreshold: value.manualReviewThreshold,
  };
}

function useLedger() {
  const active = useRef(false);
  const operations = useRef(new Map<string, Operation>());
  const drafts = useRef(new Map<string, PolicyDraft>());
  const [, setRevision] = useState(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const publish = useCallback((key: string, operation: Operation) => {
    if (!active.current) return;
    operations.current.set(key, operation);
    setRevision((value) => value + 1);
  }, []);
  const get = useCallback((key: string) => operations.current.get(key), []);
  const getDraft = useCallback(
    (key: string) => drafts.current.get(key) ?? emptyDraft,
    [],
  );
  const setDraft = useCallback((key: string, draft: PolicyDraft) => {
    const current = operations.current.get(key);
    if (
      !active.current ||
      current?.kind === "pending" ||
      current?.kind === "unknown"
    )
      return;
    drafts.current.set(key, draft);
    operations.current.delete(key);
    setRevision((value) => value + 1);
  }, []);
  const reconcile = useCallback(
    (key: string, observed: Operation | undefined, policies: Policy[]) => {
      // An earlier GET cannot release a write that was pending when that GET began.
      if (
        observed?.kind !== "unknown" ||
        operations.current.get(key) !== observed ||
        !active.current
      )
        return;
      const matched = policies.find(
        (policy) =>
          policy.version === observed.intent.policy.version &&
          policy.manualReviewThreshold ===
            observed.intent.policy.manualReviewThreshold,
      );
      if (matched) {
        drafts.current.set(key, emptyDraft);
        publish(key, {
          ...observed,
          kind: "completed",
          policy: matched,
          source: "read",
        });
      } else publish(key, { ...observed, checked: true });
    },
    [publish],
  );
  const execute = async (
    key: string,
    intent: Intent,
    authorize: (isCurrent: () => boolean) => Promise<boolean | null>,
  ) => {
    const current = operations.current.get(key);
    // The lock covers this owner context, including other policy versions.
    if (
      !active.current ||
      current?.kind === "pending" ||
      current?.kind === "unknown"
    )
      return;
    const pending: Operation = {
      kind: "pending",
      intent,
      draft: getDraft(key),
    };
    publish(key, pending);
    const isCurrent = () =>
      active.current && operations.current.get(key) === pending;
    let dispatched = false;
    let confirmed = false;
    let outcome: Operation;
    try {
      const manages = await authorize(isCurrent);
      if (!isCurrent() || manages === null) return;
      if (!manages) throw new PolicyError(403);
      dispatched = true;
      // Navigation never aborts a mutation or discards its session-owned intent.
      const response = await protectedFetch(intent.path, {
        method: intent.method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          intent.method === "POST"
            ? intent.policy
            : { manualReviewThreshold: intent.policy.manualReviewThreshold },
        ),
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        outcome =
          response.status >= 500 || response.status === 401
            ? {
                ...pending,
                kind: "unknown",
                confirmed: false,
                status: response.status,
              }
            : {
                ...pending,
                kind: "rejected",
                status: response.status,
                preflight: false,
              };
      } else {
        confirmed = true;
        const result = (await response.json()) as { policy: unknown };
        if (!isCurrent()) return;
        const policy = parsePolicy(result.policy);
        if (
          policy.version !== intent.policy.version ||
          policy.manualReviewThreshold !== intent.policy.manualReviewThreshold
        )
          throw new Error("Policy response intent mismatch");
        drafts.current.set(key, emptyDraft);
        outcome = { ...pending, kind: "completed", policy, source: "response" };
      }
    } catch (failure) {
      if (!isCurrent()) return;
      outcome = dispatched
        ? { ...pending, kind: "unknown", confirmed }
        : {
            ...pending,
            kind: "rejected",
            preflight: true,
            status: failure instanceof PolicyError ? failure.status : undefined,
          };
    }
    if (!isCurrent()) return;
    publish(key, outcome);
    return outcome;
  };
  return { get, getDraft, setDraft, execute, reconcile };
}

const PolicyMutations = createContext<ReturnType<typeof useLedger> | null>(
  null,
);
export function PolicyMutationsProvider({ children }: { children: ReactNode }) {
  const ledger = useLedger();
  return (
    <PolicyMutations.Provider value={ledger}>
      {children}
    </PolicyMutations.Provider>
  );
}
export function usePolicyMutations() {
  const ledger = useContext(PolicyMutations);
  if (!ledger) throw new Error("PolicyMutationsProvider is required");
  return ledger;
}
