import { AuthError, type AuthUser } from "./auth.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { authorizeContext, ownerType } from "./invoices.js";
import {
  createEvidencePersistence,
  EvidenceIntegrityError,
} from "./evidence-persistence.js";
import { verifyEvidenceProofV2 } from "./evidence.js";
import type { ResourceContext } from "./resources.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function evidenceId(input: unknown): string {
  if (typeof input !== "string" || !UUID.test(input))
    throw new AuthError(400, "Invalid evidence identifier");
  return input;
}

export function parseEvidenceQuery(
  input: Record<string, unknown>,
  list: boolean,
) {
  const allowed = list
    ? ["organizationId", "ownerType", "ownerId", "limit", "cursor", "recordId"]
    : ["organizationId", "ownerType", "ownerId"];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    (input.ownerType !== "user" && input.ownerType !== "group")
  )
    throw new AuthError(400, "Invalid evidence query");
  const context: ResourceContext = {
    organizationId: evidenceId(input.organizationId),
    ownerType: input.ownerType,
    ownerId: evidenceId(input.ownerId),
  };
  const limit =
    input.limit === undefined
      ? 50
      : typeof input.limit === "string" && /^[1-9]\d{0,2}$/.test(input.limit)
        ? Number(input.limit)
        : NaN;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(input.cursor)))
  )
    throw new AuthError(400, "Invalid evidence query");
  return {
    context,
    limit,
    cursor: input.cursor as string | undefined,
    recordId:
      input.recordId === undefined ? undefined : evidenceId(input.recordId),
  };
}

type Query = Omit<ReturnType<typeof parseEvidenceQuery>, "context">;
type Kind = "records" | "batches";
const recordSelect = {
  id: true,
  decisionEventId: true,
  invoiceRecordId: true,
  createdAt: true,
  evidenceVersion: true,
  canonicalVersion: true,
  leafHash: true,
} as const;
const batchSelect = {
  id: true,
  createdAt: true,
  rootHash: true,
  leafCount: true,
  policyVersion: true,
} as const;
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
function recordMetadata(row: {
  id: string;
  decisionEventId: string;
  invoiceRecordId: string;
  createdAt: Date;
  evidenceVersion: string;
  canonicalVersion: string;
  leafHash: Uint8Array;
}) {
  return {
    id: row.id,
    decisionEventId: row.decisionEventId,
    invoiceRecordId: row.invoiceRecordId,
    createdAt: row.createdAt.toISOString(),
    evidenceVersion: row.evidenceVersion,
    canonicalVersion: row.canonicalVersion,
    leafHash: hex(row.leafHash),
    integrity: "not-checked" as const,
  };
}
function batchMetadata(row: {
  id: string;
  createdAt: Date;
  rootHash: Uint8Array;
  leafCount: number;
  policyVersion: string;
}) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    rootHash: hex(row.rootHash),
    leafCount: row.leafCount,
    policyVersion: row.policyVersion,
    integrity: "not-checked" as const,
  };
}
function cursorKey(
  context: ResourceContext,
  kind: Kind,
  query: Query,
  id: string,
) {
  return [
    1,
    context.organizationId,
    context.ownerType,
    context.ownerId,
    kind,
    query.recordId ?? null,
    id,
  ];
}
function encodeCursor(
  context: ResourceContext,
  kind: Kind,
  query: Query,
  id: string,
) {
  return Buffer.from(
    JSON.stringify(cursorKey(context, kind, query, id)),
  ).toString("base64url");
}
function decodeCursor(
  context: ResourceContext,
  kind: Kind,
  query: Query,
): string | undefined {
  if (!query.cursor) return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    );
    if (!Array.isArray(value) || value.length !== 7)
      throw new Error("Invalid cursor");
    const id = evidenceId(value[6]);
    if (
      JSON.stringify(value) !==
      JSON.stringify(cursorKey(context, kind, query, id))
    )
      throw new Error("Invalid cursor");
    return id;
  } catch {
    throw new AuthError(400, "Invalid evidence cursor");
  }
}

export function createEvidenceReadService(prisma: PrismaClient) {
  const native = createEvidencePersistence(prisma);
  async function authorize(actor: AuthUser, context: ResourceContext) {
    try {
      await authorizeContext(prisma, actor.id, context);
    } catch (error) {
      // Preserve native SELF/org/group policy; only the transport distinction changes.
      if (error instanceof AuthError && error.status === 404)
        throw new AuthError(403, "Forbidden");
      throw error;
    }
  }
  const scope = (context: ResourceContext) => ({
    organizationId: context.organizationId,
    ownerType: ownerType(context.ownerType),
    ownerId: context.ownerId,
  });
  return {
    async list(
      actor: AuthUser,
      context: ResourceContext,
      kind: Kind,
      query: Query,
    ) {
      await authorize(actor, context);
      const id = decodeCursor(context, kind, query);
      const where = scope(context);
      // Resolve the unique cursor in the same context/filter before using it. Prisma
      // compares database timestamps, not truncated JavaScript Date boundary values.
      const filter =
        kind === "records"
          ? { ...where, ...(query.recordId ? { id: query.recordId } : {}) }
          : {
              ...where,
              ...(query.recordId
                ? {
                    items: {
                      some: { ...where, evidenceRecordId: query.recordId },
                    },
                  }
                : {}),
            };
      if (id) {
        const boundary =
          kind === "records"
            ? await prisma.evidenceRecord.findFirst({
                where: { AND: [filter, { id }] },
                select: { id: true },
              })
            : await prisma.evidenceBatch.findFirst({
                where: { AND: [filter, { id }] },
                select: { id: true },
              });
        if (!boundary) throw new AuthError(400, "Invalid evidence cursor");
      }
      const pagination = {
        orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
        take: query.limit + 1,
        ...(id ? { cursor: { id }, skip: 1 } : {}),
      };
      const rows =
        kind === "records"
          ? (
              await prisma.evidenceRecord.findMany({
                where: filter,
                select: recordSelect,
                ...pagination,
              })
            ).map(recordMetadata)
          : (
              await prisma.evidenceBatch.findMany({
                where: filter,
                select: batchSelect,
                ...pagination,
              })
            ).map(batchMetadata);
      const page = rows.slice(0, query.limit);
      return {
        items: page,
        nextCursor:
          rows.length > query.limit
            ? encodeCursor(context, kind, query, page.at(-1)!.id)
            : null,
      };
    },
    async record(actor: AuthUser, context: ResourceContext, id: string) {
      await authorize(actor, context);
      const row = await native.getRecord(actor, context, id);
      return {
        record: {
          id: row.id,
          decisionEventId: row.decisionEventId,
          invoiceRecordId: row.invoiceRecordId,
          createdAt: row.createdAt,
          evidenceVersion: row.evidenceVersion,
          canonicalVersion: row.canonicalVersion,
          leafHash: row.leafHash,
          integrity: "server-verified" as const,
        },
      };
    },
    async batch(actor: AuthUser, context: ResourceContext, id: string) {
      await authorize(actor, context);
      const verified = await native.getBatch(actor, context, id);
      const row = await prisma.evidenceBatch.findFirst({
        where: { ...scope(context), id },
        select: {
          createdAt: true,
          items: {
            where: scope(context),
            orderBy: { leafIndex: "asc" },
            take: 256,
            select: { evidenceRecordId: true, leafIndex: true },
          },
        },
      });
      if (!row || row.items.length !== verified.leafCount)
        throw new EvidenceIntegrityError();
      return {
        batch: {
          id: verified.id,
          rootHash: verified.rootHash,
          leafCount: verified.leafCount,
          policyVersion: verified.policyVersion,
          createdAt: row.createdAt.toISOString(),
          integrity: "server-verified" as const,
          items: row.items.map((item) => ({
            recordId: item.evidenceRecordId,
            leafIndex: item.leafIndex,
          })),
        },
      };
    },
    async proof(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
      recordId: string,
    ) {
      await authorize(actor, context);
      const value = await native.getProof(actor, context, batchId, recordId);
      if (!verifyEvidenceProofV2(value)) throw new EvidenceIntegrityError();
      return {
        proof: {
          batchId,
          recordId,
          leafHash: value.leafHash,
          rootHash: value.rootHash,
          leafIndex: value.leafIndex,
          leafCount: value.leafCount,
          policyVersion: value.policyVersion,
          proof: value.proof.map(
            ([side, hash]) => [side, hash] as ["left" | "right", string],
          ),
          integrity: "server-verified" as const,
        },
      };
    },
  };
}
export type EvidenceReadService = ReturnType<typeof createEvidenceReadService>;
