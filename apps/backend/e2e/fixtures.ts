// Deterministic fixtures of the browser E2E suite. Shared by the seed (which
// writes them) and the specs (which log in as these people). Nothing here is a
// secret: the password only exists inside the throwaway test database.

export const E2E_PASSWORD = "e2e-Correct-horse-9";

function verificationDigitFor(body: string): string {
  let sum = 0;
  let multiplier = 2;
  for (const digit of [...body].reverse()) {
    sum += Number(digit) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = sum % 11;
  return remainder === 0 ? "0" : remainder === 1 ? "K" : String(11 - remainder);
}

/** "12345678" -> { api: "12345678-5", canonical: "123456785" }. */
export function rutOf(body: string) {
  const dv = verificationDigitFor(body);
  return { api: `${body}-${dv}`, canonical: `${body}${dv}` };
}

export const ALL_FLAGS = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
};
export const NO_FLAGS = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
export const READ_ONLY = { ...NO_FLAGS, readInvoices: true };

export type Person = {
  key: string;
  name: string;
  rut: { api: string; canonical: string };
};

const person = (key: string, name: string, body: string): Person => ({
  key,
  name,
  rut: rutOf(body),
});

export const people = {
  platform: person("platform", "Paula Plataforma", "11111111"),
  acmeAdmin: person("acmeAdmin", "Ana Administradora", "12000001"),
  acmeUser: person("acmeUser", "Ulises Usuario", "12000002"),
  carla: person("carla", "Carla Soto", "12000003"),
  diego: person("diego", "Diego Rojas", "12000004"),
  elena: person("elena", "Elena Vidal", "12000005"),
  felipe: person("felipe", "Felipe Mora", "12000006"),
  betaAdmin: person("betaAdmin", "Bruno Beta", "12000007"),
  loner: person("loner", "Laura Sola", "12000008"),
} as const;

export const organizations = {
  acme: { name: "Acme Logística", slug: "acme-logistica" },
  beta: { name: "Beta Servicios", slug: "beta-servicios" },
  // The only organization the platform administrator belongs to. Organization
  // screens resolve through the person's own memberships, so the specs that
  // need the platform administrator inside an organization read this one
  // instead of adding the administrator to an organization of their own.
  gamma: { name: "Gamma Plataforma", slug: "gamma-plataforma" },
} as const;

export const groups = {
  accounting: { name: "Contabilidad", description: "Cuentas por pagar" },
  purchasing: { name: "Compras", description: "Proveedores y órdenes" },
  operations: { name: "Operaciones", description: null },
} as const;

export const invoices = [
  { businessId: "FAC-1001", supplier: "Proveedor Andes SpA", amount: 125000 },
  {
    businessId: "FAC-1002",
    supplier: "Servicios Pacífico Ltda",
    amount: 89990,
  },
  { businessId: "FAC-1003", supplier: "Insumos del Sur", amount: 450000 },
] as const;
