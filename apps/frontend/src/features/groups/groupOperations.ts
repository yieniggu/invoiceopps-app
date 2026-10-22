import { useRef, useState } from "react";

export type GroupIntent = {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: string;
  label?: string;
};
export type GroupOperation = {
  key: string;
  memberId?: string;
  intent: GroupIntent;
  kind: "pending" | "unknown" | "confirmed" | "rejected";
  refreshFailed?: boolean;
};

export function groupMemberTarget(groupPath: string, input: unknown) {
  if (typeof input !== "string" || !input.trim()) return null;
  // Match POST parseMemberInput's trim without case-folding TEXT identifiers.
  const userId = input.trim();
  try {
    return {
      userId,
      path: `${groupPath}/members/${encodeURIComponent(userId)}`,
    };
  } catch {
    // A malformed UTF-16 draft cannot be represented as a URI path segment.
    return null;
  }
}

export function normalizeGroupIntent(intent: GroupIntent) {
  // Creating twice in one organization is unsafe without a server receipt, even
  // if the operator changes the name (names are deliberately not unique).
  const member = intent.path.match(
    /^(\/organizations\/[^/?]+\/groups\/[^/?]+)\/members(?:\/([^/?]+))?$/,
  );
  if (!member) return { key: intent.path, intent: { ...intent } };
  try {
    if (intent.method === "POST" && member[2] === undefined) {
      const input: unknown = JSON.parse(intent.body ?? "{}");
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        !("userId" in input)
      )
        return null;
      const target = groupMemberTarget(member[1], input.userId);
      if (!target) return null;
      return {
        key: target.path,
        memberId: target.userId,
        intent: { ...intent, body: JSON.stringify({ userId: target.userId }) },
      };
    }
    if (intent.method === "DELETE" && member[2] !== undefined) {
      const target = groupMemberTarget(
        member[1],
        decodeURIComponent(member[2]),
      );
      if (!target) return null;
      return {
        key: target.path,
        memberId: target.userId,
        intent: { ...intent, path: target.path },
      };
    }
  } catch {
    // Invalid JSON or URI input is rejected before acquiring a slot or dispatch.
    return null;
  }
  return null;
}

export function useGroupOperations() {
  const operations = useRef(new Map<string, GroupOperation>());
  const generation = useRef(0);
  const [, publish] = useState(0);
  const notify = () => publish((value) => value + 1);
  const blocked = (
    path: string,
    method: GroupIntent["method"],
    body?: unknown,
  ) => {
    const target = normalizeGroupIntent({
      path,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!target) return true;
    const operation = operations.current.get(target.key);
    return (
      operation?.kind === "pending" ||
      operation?.kind === "unknown" ||
      (operation?.kind === "confirmed" && !!operation.refreshFailed)
    );
  };
  const begin = (intent: GroupIntent) => {
    const target = normalizeGroupIntent(intent);
    if (!target) return null;
    const { key } = target;
    const prior = operations.current.get(key);
    if (
      prior?.kind === "pending" ||
      prior?.kind === "unknown" ||
      (prior?.kind === "confirmed" && prior.refreshFailed)
    )
      return null;
    let operation: GroupOperation = {
      ...target,
      kind: "pending",
    };
    operations.current.set(key, operation);
    const epoch = generation.current;
    notify();
    const current = () =>
      generation.current === epoch && operations.current.get(key) === operation;
    return {
      intent: operation.intent,
      current,
      finish(kind: GroupOperation["kind"], refreshFailed = false) {
        if (!current()) return;
        operation = { ...operation, kind, refreshFailed };
        operations.current.set(key, operation);
        notify();
      },
    };
  };
  const suspend = () => {
    generation.current += 1;
    for (const [key, operation] of operations.current) {
      if (operation.kind === "pending")
        operations.current.set(key, { ...operation, kind: "unknown" });
    }
    notify();
  };
  const reset = () => {
    generation.current += 1;
    operations.current.clear();
    notify();
  };
  const beginRead = () => {
    const observed = [...operations.current.entries()].filter(
      ([, operation]) =>
        operation.kind === "confirmed" && operation.refreshFailed,
    );
    return () => {
      for (const [key, operation] of observed) {
        if (operations.current.get(key) === operation)
          operations.current.set(key, { ...operation, refreshFailed: false });
      }
      notify();
    };
  };
  return {
    begin,
    blocked,
    suspend,
    reset,
    beginRead,
    operations: [...operations.current.values()],
  };
}
