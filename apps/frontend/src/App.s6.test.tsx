import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const record = {
  id: id(1),
  decisionEventId: id(2),
  invoiceRecordId: id(3),
  createdAt: "2026-10-21T00:00:00Z",
  evidenceVersion: "invoice-evidence-v2",
  canonicalVersion: "invoice-evidence-canonical-v2",
  leafHash: "0x" + "ab".repeat(32),
  integrity: "not-checked",
};
const batch = {
  id: id(4),
  createdAt: record.createdAt,
  rootHash: "0x" + "cd".repeat(32),
  leafCount: 2,
  policyVersion: "invoice-merkle-v2",
  integrity: "not-checked",
};
const proof = {
  batchId: batch.id,
  recordId: record.id,
  leafHash: record.leafHash,
  rootHash: batch.rootHash,
  leafIndex: 0,
  leafCount: 2,
  policyVersion: batch.policyVersion,
  proof: [["right", "0x" + "ef".repeat(32)]],
  integrity: "server-verified",
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function http(platform = false, member = true) {
  const read = vi
    .fn<(url: URL) => Promise<Response>>()
    .mockImplementation(async (url) => {
      if (url.pathname.includes("/proofs/")) return json({ proof });
      if (url.pathname === `/evidence-records/${record.id}`)
        return json({ record: { ...record, integrity: "server-verified" } });
      if (url.pathname === `/evidence-batches/${batch.id}`)
        return json({
          batch: {
            ...batch,
            integrity: "server-verified",
            items: [
              { recordId: record.id, leafIndex: 0 },
              { recordId: id(9), leafIndex: 1 },
            ],
          },
        });
      return json({
        items: url.pathname === "/evidence-records" ? [record] : [batch],
        nextCursor: null,
      });
    });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = new URL(String(input), "http://test.invalid");
      if (url.pathname === "/profile")
        return json({
          profile: {
            id: "user",
            name: "Persona",
            rut: "123456785",
            email: null,
            username: null,
            isPlatformAdministrator: platform,
            memberships: member
              ? [
                  {
                    organization: {
                      id: "org",
                      name: "Academia",
                      slug: "academy",
                    },
                    role: "STUDENT",
                  },
                ]
              : [],
          },
        });
      if (url.pathname === "/groups")
        return json({
          groups: [
            {
              id: "group",
              name: "Equipo",
              organization: { id: "org", name: "Academia" },
              members: [],
            },
          ],
        });
      if (url.pathname === "/platform/organizations")
        return json({
          organizations: [
            { id: "foreign", name: "Solo descubrimiento", slug: "foreign" },
          ],
        });
      if (url.pathname.startsWith("/evidence-")) return read(url);
      if (url.pathname === "/auth/logout")
        return new Response(null, { status: 204 });
      if (url.pathname === "/auth/login") return json({});
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
  return { read, fetchMock };
}
async function open() {
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /^Evidencia y lotes$/ }),
  );
}
function group() {
  fireEvent.change(screen.getByLabelText("Propietario"), {
    target: { value: "org:group:group" },
  });
}

describe("APP12 S6 contextual evidence", () => {
  it("exposes evidence navigation without eagerly reading evidence and offers a dashboard entry", async () => {
    const api = http();
    render(<App />);
    expect(
      await screen.findByRole("button", { name: /^Evidencia y lotes$/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Abrir evidencia y lotes" }),
    ).toBeTruthy();
    expect(api.read).not.toHaveBeenCalled();
  });
  it("loads only a bounded page, opens real record details on demand and filters batches by that record", async () => {
    const api = http();
    await open();
    await screen.findByRole("button", { name: `Ver registro ${record.id}` });
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(api.read.mock.calls[0][0].search).toBe(
      "?organizationId=org&ownerType=user&ownerId=user&limit=50",
    );
    expect(
      screen.queryByText(/Integridad verificada por el servidor/),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: `Ver registro ${record.id}` }),
    );
    await screen.findByText(/Integridad verificada por el servidor/);
    const detail = screen.getByRole("region", { name: "Detalle de evidencia" });
    expect(within(detail).getByText(record.leafHash)).toBeTruthy();
    expect(within(detail).getByText(record.canonicalVersion)).toBeTruthy();
    expect(api.read).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Ver lotes de este registro" }),
    );
    await screen.findByRole("button", { name: `Ver lote ${batch.id}` });
    expect(api.read.mock.calls[2][0].searchParams.get("recordId")).toBe(
      record.id,
    );
    expect(
      screen.queryByRole("region", { name: "Detalle de evidencia" }),
    ).toBeNull();
    expect(
      api.fetchMock.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
  });
  it("fetches one native proof only after a member is selected, locks pending JSON and presents the exact sibling direction/hash", async () => {
    const api = http();
    await open();
    await screen.findByRole("button", { name: `Ver registro ${record.id}` });
    fireEvent.click(screen.getByRole("button", { name: /^Lotes$/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: `Ver lote ${batch.id}` }),
    );
    const button = await screen.findByRole("button", {
      name: `Consultar prueba de ${record.id}`,
    });
    expect(
      api.read.mock.calls.some(([url]) => url.pathname.includes("/proofs/")),
    ).toBe(false);
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.read.mockResolvedValueOnce(response);
    fireEvent.click(button);
    await waitFor(() => expect(parse).toHaveBeenCalledOnce());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(
      api.read.mock.calls.filter(([url]) => url.pathname.includes("/proofs/"))
        .length,
    ).toBe(1);
    await act(async () => body.resolve({ proof }));
    const region = screen.getByRole("region", { name: "Prueba Merkle" });
    expect(within(region).getByText("Derecha")).toBeTruthy();
    expect(within(region).getByText(proof.proof[0][1])).toBeTruthy();
    expect(
      within(region).getByText(
        /no realizó una verificación criptográfica independiente/,
      ),
    ).toBeTruthy();
    expect(
      within(region).getByText(/un recibo no equivale a finalidad/),
    ).toBeTruthy();
  });
  it("paginates explicitly, clears details and resets cursors/filters when context changes", async () => {
    const api = http();
    api.read.mockResolvedValueOnce(
      json({ items: [record], nextCursor: "context_cursor" }),
    );
    await open();
    await screen.findByRole("button", { name: "Página siguiente" });
    expect(api.read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Página siguiente" }));
    await screen.findByRole("button", { name: "Primera página" });
    expect(api.read.mock.calls[1][0].searchParams.get("cursor")).toBe(
      "context_cursor",
    );
    await screen.findByRole("button", { name: `Ver registro ${record.id}` });
    fireEvent.change(screen.getByLabelText("Identificador de registro"), {
      target: { value: record.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Filtrar registros" }));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(3));
    expect(api.read.mock.calls[2][0].searchParams.get("cursor")).toBeNull();
    expect(api.read.mock.calls[2][0].searchParams.get("recordId")).toBe(
      record.id,
    );
    screen.getByLabelText("Propietario").focus();
    group();
    expect(document.activeElement).toBe(screen.getByLabelText("Propietario"));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(4));
    expect(api.read.mock.calls[3][0].searchParams.get("recordId")).toBeNull();
    expect(api.read.mock.calls[3][0].searchParams.get("cursor")).toBeNull();
    expect(api.read.mock.calls[3][0].searchParams.get("ownerId")).toBe("group");
  });
  it.each([403, 404, 409, 500])(
    "shows safe explicit HTTP %s errors, not empty or verified data, and recovers by GET",
    async (status) => {
      const api = http();
      api.read.mockResolvedValueOnce(
        json(
          {
            code:
              status === 409 ? "INTEGRITY_INVALID" : "private-provider-stack",
            message: "private-payload",
          },
          status,
        ),
      );
      await open();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(
        status === 403
          ? "No tienes acceso"
          : status === 404
            ? "no está disponible"
            : status === 409
              ? "La integridad no es válida"
              : "No fue posible consultar",
      );
      expect(document.body.textContent).not.toContain("private-");
      expect(screen.queryByText(/No hay registros/)).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Reintentar lectura" }),
      );
      await screen.findByRole("button", { name: `Ver registro ${record.id}` });
      expect(api.read).toHaveBeenCalledTimes(2);
    },
  );
  it("distinguishes successful empty results, validates exact UUID filters and ignores visibility events", async () => {
    const api = http();
    api.read.mockResolvedValueOnce(json({ items: [], nextCursor: null }));
    await open();
    await screen.findByText("No hay registros para esta consulta.");
    fireEvent.change(screen.getByLabelText("Identificador de registro"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Filtrar registros" }));
    await screen.findByText(/Ingresa un UUID/);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.read).toHaveBeenCalledTimes(1);
  });
  it.each(["response", "body", "401"])(
    "ignores late A %s and finalization while B remains pending",
    async (outcome) => {
      const api = http();
      const old = deferred<Response>();
      const body = deferred<unknown>();
      const current = deferred<Response>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      api.read
        .mockReturnValueOnce(
          outcome === "body" ? Promise.resolve(response) : old.promise,
        )
        .mockReturnValueOnce(current.promise);
      await open();
      await screen.findByText("Cargando evidencia...");
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      group();
      const oldCall = api.fetchMock.mock.calls.find(([path]) =>
        String(path).startsWith("/evidence-records"),
      );
      expect(oldCall?.[1]?.signal?.aborted).toBe(true);
      await act(async () => {
        if (outcome === "body")
          body.resolve({ items: [record], nextCursor: null });
        else
          old.resolve(
            json(
              { items: [record], nextCursor: null },
              outcome === "401" ? 401 : 200,
            ),
          );
      });
      expect(screen.queryByText(record.id)).toBeNull();
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Actualizar listado" }),
      ).toHaveProperty("disabled", true);
      fireEvent.click(
        screen.getByRole("button", { name: "Actualizar listado" }),
      );
      expect(api.read).toHaveBeenCalledTimes(2);
      await act(async () =>
        current.resolve(json({ items: [record], nextCursor: null })),
      );
      await screen.findByRole("button", { name: `Ver registro ${record.id}` });
    },
  );
  it("expires only the current session on a current 401", async () => {
    const api = http();
    api.read.mockResolvedValueOnce(json({}, 401));
    await open();
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(api.read).toHaveBeenCalledTimes(1);
  });
  it.each(["body", "401"])(
    "cannot restore or expire a new same-user session with an old %s",
    async (outcome) => {
      const api = http();
      const old = deferred<Response>();
      const body = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      api.read.mockReturnValueOnce(
        outcome === "body" ? Promise.resolve(response) : old.promise,
      );
      await open();
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      await screen.findByRole("button", { name: "Iniciar sesión" });
      fireEvent.change(screen.getByLabelText("RUT"), {
        target: { value: "123456785" },
      });
      fireEvent.change(screen.getByLabelText("Contraseña"), {
        target: { value: "synthetic-password" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
      fireEvent.click(
        await screen.findByRole("button", { name: /^Evidencia y lotes$/ }),
      );
      await screen.findByRole("button", { name: `Ver registro ${record.id}` });
      await act(async () => {
        if (outcome === "body")
          body.resolve({
            items: [{ ...record, id: id(99) }],
            nextCursor: null,
          });
        else old.resolve(json({}, 401));
      });
      expect(screen.queryByText(id(99))).toBeNull();
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(api.read).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["record", "proof"])(
    "aborts a pending %s body on route departure without restoring data or expiring the session",
    async (target) => {
      const api = http();
      await open();
      await screen.findByRole("button", { name: `Ver registro ${record.id}` });
      if (target === "proof") {
        fireEvent.click(screen.getByRole("button", { name: /^Lotes$/ }));
        fireEvent.click(
          await screen.findByRole("button", { name: `Ver lote ${batch.id}` }),
        );
        await screen.findByRole("button", {
          name: `Consultar prueba de ${record.id}`,
        });
      }
      const body = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      api.read.mockResolvedValueOnce(response);
      fireEvent.click(
        screen.getByRole("button", {
          name:
            target === "record"
              ? `Ver registro ${record.id}`
              : `Consultar prueba de ${record.id}`,
        }),
      );
      await waitFor(() => expect(parse).toHaveBeenCalledOnce());
      const call = api.fetchMock.mock.calls.at(-1);
      fireEvent.click(
        screen.getByRole("button", { name: /^Panel principal$/ }),
      );
      expect(call?.[1]?.signal?.aborted).toBe(true);
      await act(async () =>
        body.resolve(
          target === "record"
            ? { record: { ...record, integrity: "server-verified" } }
            : { proof },
        ),
      );
      expect(
        screen.queryByRole("region", { name: "Detalle de evidencia" }),
      ).toBeNull();
      expect(
        screen.queryByRole("region", { name: "Prueba Merkle" }),
      ).toBeNull();
      expect(screen.getByRole("navigation")).toBeTruthy();
    },
  );
  it("never grants evidence context from platform discovery", async () => {
    const platform = http(true, false);
    await open();
    await screen.findByText(
      "No tienes un contexto autorizado para consultar evidencia.",
    );
    expect(platform.read).not.toHaveBeenCalled();
  });
  it("clears verified details before a list refresh can report revoked access", async () => {
    const api = http();
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: `Ver registro ${record.id}` }),
    );
    await screen.findByText(/Integridad verificada por el servidor/);
    api.read.mockResolvedValueOnce(json({}, 403));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar listado" }));
    expect(
      screen.queryByRole("region", { name: "Detalle de evidencia" }),
    ).toBeNull();
    await screen.findByText(/No tienes acceso a este contexto/);
    expect(screen.queryByText(record.leafHash)).toBeNull();
  });
});
