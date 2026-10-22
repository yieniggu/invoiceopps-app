import { useCallback, useEffect, useRef, useState } from "react";
import { useUnauthorized } from "../auth/ProtectedSession";

export type EvidenceRecord = {
  id: string;
  decisionEventId: string;
  invoiceRecordId: string;
  createdAt: string;
  evidenceVersion: string;
  canonicalVersion: string;
  leafHash: string;
  integrity: "not-checked" | "server-verified";
};
export type EvidenceBatch = {
  id: string;
  createdAt: string;
  rootHash: string;
  leafCount: number;
  policyVersion: string;
  integrity: "not-checked" | "server-verified";
  items?: Array<{ recordId: string; leafIndex: number }>;
};
export type EvidenceProof = {
  batchId: string;
  recordId: string;
  leafHash: string;
  rootHash: string;
  leafIndex: number;
  leafCount: number;
  policyVersion: string;
  proof: Array<["left" | "right", string]>;
  integrity: "server-verified";
};
export type EvidencePage = {
  items: Array<EvidenceRecord | EvidenceBatch>;
  nextCursor: string | null;
};
export type ReadState<T> =
  | { kind: "idle" | "loading" }
  | { kind: "error"; status?: number; code?: string }
  | { kind: "loaded"; data: T };
class ReadError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super("Evidence read failed");
  }
}

// This owner holds its lock through JSON parsing and checks request identity at
// every asynchronous boundary, including session expiry and finalization.
export function useEvidenceRead<T>(
  path: string | null,
  parse: (input: unknown) => T,
) {
  const unauthorized = useUnauthorized();
  const [state, setState] = useState<ReadState<T>>({
    kind: path ? "loading" : "idle",
  });
  const active = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const load = useCallback(async () => {
    if (!path || active.current || !alive.current) return;
    const controller = new AbortController();
    active.current = controller;
    const current = () =>
      alive.current &&
      active.current === controller &&
      !controller.signal.aborted;
    setState({ kind: "loading" });
    try {
      const response = await fetch(path, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!current()) return;
      if (response.status === 401) throw new ReadError(401);
      const value: unknown = await response.json();
      if (!current()) return;
      if (!response.ok) {
        const code =
          value &&
          typeof value === "object" &&
          "code" in value &&
          value.code === "INTEGRITY_INVALID"
            ? "INTEGRITY_INVALID"
            : undefined;
        throw new ReadError(response.status, code);
      }
      const data = parse(value);
      if (current()) setState({ kind: "loaded", data });
    } catch (error) {
      if (!current()) return;
      const status = error instanceof ReadError ? error.status : undefined;
      setState({
        kind: "error",
        status,
        code: error instanceof ReadError ? error.code : undefined,
      });
      if (status === 401) unauthorized();
    } finally {
      if (current()) active.current = null;
    }
  }, [path, parse, unauthorized]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, [load]);
  return { state, load };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid evidence response");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024)
    throw new Error("Invalid evidence metadata");
  return value;
}
function hash(value: unknown): string {
  const result = text(value);
  if (!/^0x[0-9a-f]{64}$/.test(result))
    throw new Error("Invalid evidence hash");
  return result;
}
function count(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new Error("Invalid evidence count");
  return value;
}
function integrity(value: unknown) {
  if (value !== "not-checked" && value !== "server-verified")
    throw new Error("Invalid integrity status");
  return value;
}
function record(value: unknown): EvidenceRecord {
  const row = object(value);
  return {
    id: text(row.id),
    decisionEventId: text(row.decisionEventId),
    invoiceRecordId: text(row.invoiceRecordId),
    createdAt: text(row.createdAt),
    evidenceVersion: text(row.evidenceVersion),
    canonicalVersion: text(row.canonicalVersion),
    leafHash: hash(row.leafHash),
    integrity: integrity(row.integrity),
  };
}
function batch(value: unknown): EvidenceBatch {
  const row = object(value);
  const result: EvidenceBatch = {
    id: text(row.id),
    createdAt: text(row.createdAt),
    rootHash: hash(row.rootHash),
    leafCount: count(row.leafCount, 256),
    policyVersion: text(row.policyVersion),
    integrity: integrity(row.integrity),
  };
  if (result.leafCount < 1) throw new Error("Invalid batch size");
  if (row.items !== undefined) {
    if (!Array.isArray(row.items) || row.items.length !== result.leafCount)
      throw new Error("Invalid batch membership");
    result.items = row.items.map((value, index) => {
      const item = object(value);
      if (item.leafIndex !== index) throw new Error("Invalid batch membership");
      return { recordId: text(item.recordId), leafIndex: index };
    });
  }
  return result;
}
export function parseRecords(value: unknown): EvidencePage {
  return page(value, record);
}
export function parseBatches(value: unknown): EvidencePage {
  return page(value, batch);
}
function page(
  value: unknown,
  parse: (row: unknown) => EvidenceRecord | EvidenceBatch,
): EvidencePage {
  const data = object(value);
  if (
    !Array.isArray(data.items) ||
    data.items.length > 100 ||
    (data.nextCursor !== null && typeof data.nextCursor !== "string")
  )
    throw new Error("Invalid evidence page");
  const items = data.items.map(parse);
  if (items.some((row) => row.integrity !== "not-checked"))
    throw new Error("Unexpected list verification");
  return {
    items,
    nextCursor: data.nextCursor === null ? null : text(data.nextCursor),
  };
}
export function parseRecordDetail(value: unknown) {
  const result = record(object(value).record);
  if (result.integrity !== "server-verified")
    throw new Error("Unverified record");
  return result;
}
export function parseBatchDetail(value: unknown) {
  const result = batch(object(value).batch);
  if (result.integrity !== "server-verified" || !result.items)
    throw new Error("Unverified batch");
  return result;
}
export function parseProof(value: unknown): EvidenceProof {
  const row = object(object(value).proof);
  if (
    row.integrity !== "server-verified" ||
    !Array.isArray(row.proof) ||
    row.proof.length > 8
  )
    throw new Error("Unverified proof");
  const leafCount = count(row.leafCount, 256),
    leafIndex = count(row.leafIndex, 255);
  if (!leafCount || leafIndex >= leafCount)
    throw new Error("Invalid proof position");
  return {
    batchId: text(row.batchId),
    recordId: text(row.recordId),
    leafHash: hash(row.leafHash),
    rootHash: hash(row.rootHash),
    leafCount,
    leafIndex,
    policyVersion: text(row.policyVersion),
    integrity: "server-verified",
    proof: row.proof.map((value) => {
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        (value[0] !== "left" && value[0] !== "right")
      )
        throw new Error("Invalid proof step");
      return [value[0], hash(value[1])];
    }),
  };
}
export function readMessage(
  state: Extract<ReadState<unknown>, { kind: "error" }>,
) {
  if (state.status === 401)
    return "La sesión expiró. Inicia sesión nuevamente.";
  if (state.status === 403)
    return "No tienes acceso a este contexto. Consulta tus organizaciones o grupos.";
  if (state.status === 404)
    return "El registro, lote o miembro solicitado no está disponible en este contexto.";
  if (state.code === "INTEGRITY_INVALID")
    return "La integridad no es válida. El servidor rechazó la evidencia; no debe considerarse verificada.";
  if (state.status === 400)
    return "La consulta o el cursor no es válido. Vuelve a la primera página o revisa el identificador.";
  return "No fue posible consultar la evidencia. Reintenta solo la lectura.";
}
