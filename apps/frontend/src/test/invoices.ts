import {
  jsonResponse,
  membership,
  NO_PERMISSIONS,
  profileFixture,
  type RecordedRequest,
} from "./transport";
import { uuid } from "./ids";

// Fixtures shared by the invoice inbox and detail UI tests.

export const ME = "00000000-0000-4000-8000-000000000001";
export const norte = { id: uuid(101), name: "Academia Norte" };
export const sur = { id: uuid(102), name: "Instituto Sur" };
export const contabilidad = { id: uuid(201), name: "Contabilidad" };
export const compras = { id: uuid(202), name: "Compras" };
/** A group of Norte that `orgReader` is not a member of. */
export const finanzas = { id: uuid(203), name: "Finanzas" };
export const READ = { ...NO_PERMISSIONS, readInvoices: true };

/** Profile that reads the whole of Norte and the group Contabilidad. */
export const orgReader = () =>
  profileFixture({
    memberships: [
      membership(norte, "USER", {
        permissions: READ,
        groups: [{ group: contabilidad, effective: READ }],
      }),
    ],
  });

/** Profile that reads only the group Compras of Norte. */
export const groupReader = () =>
  profileFixture({
    memberships: [
      membership(norte, "USER", {
        groups: [{ group: compras, effective: READ }],
      }),
    ],
  });

const GROUP_NAMES: Record<string, string> = {
  [contabilidad.id]: contabilidad.name,
  [compras.id]: compras.name,
  [finanzas.id]: finanzas.name,
};

/** GET /organizations/{o}/groups answer for the given groups of Norte. */
export const groupsOf = (...groups: Array<{ id: string; name: string }>) =>
  jsonResponse({
    groups: groups.map((group) => ({
      ...group,
      organizationId: norte.id,
      description: null,
    })),
  });

/** Invoice as the API reads it: groupName follows groupId unless overridden. */
export function invoice(n: number, overrides: Record<string, unknown> = {}) {
  const groupId = (overrides.groupId as string | null | undefined) ?? null;
  return {
    id: uuid(1000 + n),
    organizationId: norte.id,
    groupId: null as string | null,
    groupName: groupId === null ? null : (GROUP_NAMES[groupId] ?? null),
    businessId: `FAC-${n}`,
    supplierName: `Proveedor ${n}`,
    amountPesos: 12500,
    currency: "CLP",
    issuedOn: "2026-10-25",
    // Far ahead on purpose: a PENDING fixture must not turn overdue with time.
    dueOn: "2099-12-31",
    businessStatus: "PENDING",
    processingStatus: "NOT_REQUESTED",
    createdByUserId: uuid(9000),
    createdAt: "2026-10-25T12:00:00.000Z",
    ...overrides,
  };
}

export function invoicePage(
  items: unknown[],
  extra: { page?: number; pageSize?: number; total?: number } = {},
) {
  return jsonResponse({
    items,
    page: extra.page ?? 1,
    pageSize: extra.pageSize ?? 20,
    total: extra.total ?? items.length,
  });
}

/** The query string of a recorded request as a plain object. */
export const queryOf = (request: RecordedRequest) =>
  Object.fromEntries(new URLSearchParams(request.search));
