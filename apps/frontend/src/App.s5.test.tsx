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
import { MlflowResources } from "./features/resources/MlflowResources";

const context = {
  organizationId: "org",
  ownerType: "user" as const,
  ownerId: "user",
};
const snapshot = {
  experiment: {
    id: "exp-1",
    name: "student/123456785/invoice-risk",
    url: "https://mlflow.example/#/experiments/exp-1",
  },
  runs: [{ runId: "run-1", url: null }],
  registeredModel: { name: "student-123456785-invoice-review" },
  versions: [{ version: "02", runId: "run-1" }, { version: "3" }],
  truncated: true,
  fetchedAt: "2026-10-21T12:00:00Z",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
function visibility(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
  else Reflect.deleteProperty(document, "hidden");
});
function http(platform = false, memberships = true) {
  const profile = {
    id: "user",
    name: "Persona",
    rut: "123456785",
    email: null,
    username: null,
    isPlatformAdministrator: platform,
    memberships: memberships
      ? [
          {
            organization: { id: "org", name: "Academia", slug: "academy" },
            role: "STUDENT",
          },
        ]
      : [],
  };
  const read = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json(snapshot));
  const references = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({
        resources: [
          { id: "ref", type: "ml-experiment", label: "Referencia propia" },
          {
            id: "unknown",
            type: "UNRECOGNIZED_PROVIDER_CODE",
            label: "Dato sin tipo conocido",
          },
        ],
      }),
    );
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const path = new URL(input.toString(), "http://test.invalid").pathname;
      if (path === "/profile") return json({ profile });
      if (path === "/groups")
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
      if (path === "/platform/organizations")
        return json({
          organizations: [
            { id: "foreign", name: "No autorizada", slug: "foreign" },
          ],
        });
      if (path === "/mlflow/resources") return read();
      if (path === "/resources") return references();
      if (path === "/auth/logout") return new Response(null, { status: 204 });
      if (path === "/auth/login") return json({});
      throw new Error(`Unexpected request: ${path}`);
    });
  return { read, references, fetchMock };
}
async function open() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^Recursos$/ }));
}
function group() {
  fireEvent.change(screen.getByLabelText("Propietario"), {
    target: { value: "org:group:group" },
  });
}

describe("APP12 S5 real resources presentation and navigation", () => {
  it("loads only on destination entry, separates navigation references and presents actual bounded metadata", async () => {
    const api = http();
    render(<App />);
    await screen.findByRole("button", { name: /^Recursos$/ });
    expect(api.read).not.toHaveBeenCalled();
    expect(api.references).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Recursos$/ }));
    await screen.findByText(snapshot.experiment.name);
    expect(screen.getByRole("heading", { name: "Ejecuciones" })).toBeTruthy();
    const refs = screen.getByRole("region", {
      name: "Referencias de navegación",
    });
    expect(within(refs).getByText("Referencia propia")).toBeTruthy();
    expect(within(refs).getByText("Experimento ML")).toBeTruthy();
    expect(within(refs).getByText("Tipo no disponible")).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "UNRECOGNIZED_PROVIDER_CODE",
    );
    expect(screen.getByText("exp-1")).toBeTruthy();
    expect(screen.getByText("Versión 02")).toBeTruthy();
    expect(screen.getByText(/25 ejecuciones y 25 versiones/)).toBeTruthy();
    expect(screen.getByText(/La API actual no expone aliases/)).toBeTruthy();
    expect(
      screen.getByText(/no copia artefactos ni entrena modelos/),
    ).toBeTruthy();
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(
      api.fetchMock.mock.calls.filter(([path]) =>
        String(path).startsWith("/mlflow/resources"),
      )[0][0],
    ).toBe("/mlflow/resources?organizationId=org&ownerType=user&ownerId=user");
    expect(
      api.fetchMock.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
  });
  it("keeps absent resources normal and invalid dates or unsafe URLs explicit without inventing provider paths", async () => {
    const api = http();
    api.read.mockResolvedValueOnce(
      json({
        ...snapshot,
        experiment: {
          id: "empty",
          name: "Nombre real",
          url: "javascript:alert(1)",
        },
        runs: [],
        registeredModel: null,
        versions: [],
        fetchedAt: "invalid",
      }),
    );
    await open();
    await screen.findByText("Nombre real");
    expect(
      within(
        screen.getByRole("region", { name: "Recursos de MLflow" }),
      ).queryByRole("link"),
    ).toBeNull();
    expect(screen.getByText("Fecha no disponible")).toBeTruthy();
    expect(screen.getByText("Enlace no disponible")).toBeTruthy();
    expect(
      screen.getByText("No hay ejecuciones para este propietario."),
    ).toBeTruthy();
    expect(
      screen.getByText("No hay modelo registrado para este propietario."),
    ).toBeTruthy();
    expect(
      screen.getByText("No hay versiones para este propietario."),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it.each([403, 404])(
    "clears a previously successful snapshot on HTTP %s instead of presenting forbidden data as stale or empty",
    async (status) => {
      const api = http();
      await open();
      await screen.findByText(snapshot.experiment.name);
      api.read.mockResolvedValueOnce(
        json({ message: "private-provider-stack" }, status),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Actualizar MLflow" }),
      );
      await screen.findByText(
        status === 403
          ? /No tienes acceso a los recursos de MLflow/
          : /Los recursos de MLflow no están disponibles/,
      );
      expect(screen.queryByText(snapshot.experiment.name)).toBeNull();
      expect(document.body.textContent).not.toContain("private-provider-stack");
      expect(screen.queryByText(/No hay experimento/)).toBeNull();
    },
  );
  it("marks only same-context 500 data as previous, recovers via GET and clears immediately on owner change", async () => {
    const api = http();
    await open();
    await screen.findByText(snapshot.experiment.name);
    api.read.mockResolvedValueOnce(json({}, 500));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar MLflow" }));
    await screen.findByText(/datos anteriores/);
    expect(screen.getByText(snapshot.experiment.name)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar MLflow" }));
    await waitFor(() =>
      expect(screen.queryByText(/datos anteriores/)).toBeNull(),
    );
    const pending = deferred<Response>();
    api.read.mockReturnValueOnce(pending.promise);
    group();
    expect(screen.queryByText(snapshot.experiment.name)).toBeNull();
    expect(screen.queryByText("Referencia propia")).toBeNull();
    await act(async () =>
      pending.resolve(
        json({
          ...snapshot,
          experiment: null,
          runs: [],
          versions: [],
          registeredModel: null,
        }),
      ),
    );
    await screen.findByText("No hay experimento para este propietario.");
  });
  it.each(["response", "body", "401"])(
    "isolates late A %s including finalization while B is pending and preserves owner focus",
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
      await screen.findByText("Cargando recursos de MLflow...");
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      screen.getByLabelText("Propietario").focus();
      group();
      expect(document.activeElement).toBe(screen.getByLabelText("Propietario"));
      const oldCall = api.fetchMock.mock.calls.find(([path]) =>
        String(path).startsWith("/mlflow/resources"),
      );
      expect(oldCall?.[1]?.signal?.aborted).toBe(true);
      await act(async () => {
        if (outcome === "body") body.resolve(snapshot);
        else old.resolve(json(snapshot, outcome === "401" ? 401 : 200));
      });
      expect(screen.queryByText(snapshot.experiment.name)).toBeNull();
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Actualizar MLflow" }),
      ).toHaveProperty("disabled", true);
      await act(async () => current.resolve(json(snapshot)));
      await screen.findByText(snapshot.experiment.name);
    },
  );
  it("expires App on current 401, clearing references and stopping polling", async () => {
    const api = http();
    api.read.mockResolvedValueOnce(json({}, 401));
    await open();
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(screen.queryByText("Referencia propia")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    act(() => visibility(false));
    expect(api.read).toHaveBeenCalledTimes(1);
  });
  it.each(["body", "401"])(
    "does not restore old session %s after logout and login of the same user",
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
        await screen.findByRole("button", { name: /^Recursos$/ }),
      );
      await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (outcome === "body") body.resolve(snapshot);
        else old.resolve(json({}, 401));
      });
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(screen.queryByText(snapshot.experiment.name)).toBeNull();
      await act(async () => current.resolve(json(snapshot)));
      await screen.findByText(snapshot.experiment.name);
    },
  );
  it("never grants resource context from platform discovery alone", async () => {
    const api = http(true, false);
    await open();
    await screen.findByText(
      "No tienes organizaciones para consultar recursos.",
    );
    expect(api.read).not.toHaveBeenCalled();
    expect(api.references).not.toHaveBeenCalled();
  });
  it("keeps reference access errors explicit and ignores an aborted reference JSON body", async () => {
    const api = http();
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.references
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(json({}, 403));
    await open();
    await waitFor(() => expect(parse).toHaveBeenCalled());
    group();
    await screen.findByText(
      "No tienes acceso a las referencias de este contexto.",
    );
    await act(async () =>
      body.resolve({
        resources: [{ id: "old", type: "ml-model", label: "A-PRIVATE" }],
      }),
    );
    expect(screen.queryByText("A-PRIVATE")).toBeNull();
    const region = screen.getByRole("region", {
      name: "Referencias de navegación",
    });
    expect(
      within(region).queryByText("No hay recursos para este propietario."),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar recursos" }),
    );
    await screen.findByText("Referencia propia");
  });
  it("distinguishes initial failure from successful empty and cleans the polling owner when leaving Recursos", async () => {
    const api = http();
    api.read.mockResolvedValueOnce(json({}, 500));
    await open();
    await screen.findByText(
      "No fue posible consultar MLflow. Puedes reintentar.",
    );
    expect(screen.queryByText(/Última consulta exitosa/)).toBeNull();
    api.read.mockResolvedValueOnce(
      json({
        ...snapshot,
        experiment: null,
        registeredModel: null,
        runs: [],
        versions: [],
        truncated: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reintentar MLflow" }));
    await screen.findByText("No hay experimento para este propietario.");
    expect(screen.queryByText(/Vista parcial/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Panel principal" }));
    act(() => visibility(false));
    expect(api.read).toHaveBeenCalledTimes(2);
  });
});

describe("APP12 S5 visible snapshot owner", () => {
  it("rejects data, relative and credential-bearing links while preserving exact HTTPS metadata and safe attributes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        ...snapshot,
        runs: [
          { runId: "unsafe-data", url: "data:text/html,unsafe" },
          { runId: "relative", url: "/redirect?target=unsafe" },
          {
            runId: "credentials",
            url: "https://secret:password@mlflow.example/",
          },
          { runId: "safe-http", url: "http://127.0.0.1:5000/#/runs/safe" },
        ],
      }),
    );
    render(<MlflowResources context={context} />);
    await screen.findByText("unsafe-data");
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(
      screen
        .getByRole("link", { name: snapshot.experiment.name })
        .getAttribute("href"),
    ).toBe(snapshot.experiment.url);
    expect(
      screen.getByRole("link", { name: "safe-http" }).getAttribute("rel"),
    ).toBe("noopener noreferrer");
    expect(
      screen.getByRole("link", { name: "safe-http" }).getAttribute("target"),
    ).toBe("_blank");
  });
  it("ignores an aborted hidden body and its finally while the resumed body remains in flight", async () => {
    vi.useFakeTimers();
    const old = deferred<unknown>();
    const current = deferred<unknown>();
    const first = json({});
    const second = json({});
    vi.spyOn(first, "json").mockReturnValue(old.promise);
    vi.spyOn(second, "json").mockReturnValue(current.promise);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockImplementation(async () => json(snapshot));
    await act(async () => {
      render(<MlflowResources context={context} />);
    });
    await act(async () => visibility(true));
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => visibility(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () =>
      old.resolve({
        ...snapshot,
        experiment: { id: "old", name: "HIDDEN-PRIVATE" },
      }),
    );
    expect(screen.queryByText("HIDDEN-PRIVATE")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Actualizar MLflow" }),
    ).toHaveProperty("disabled", true);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Actualizar MLflow" }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(snapshot));
    expect(screen.getByText(snapshot.experiment.name)).toBeTruthy();
  });
  it("holds the in-flight lock through JSON, prevents manual/timer overlap, pauses/resumes and cleans up", async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response)
      .mockImplementation(async () => json(snapshot));
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<MlflowResources context={context} />);
    });
    expect(parse).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Actualizar MLflow" }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => body.resolve(snapshot));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => visibility(true));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Actualizar MLflow" }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => visibility(false));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => {
      visibility(false);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("clears a loaded snapshot even on unkeyed context changes and remains terminal after standalone 401", async () => {
    const pending = deferred<Response>();
    const unauthorized = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => json(snapshot))
      .mockReturnValueOnce(pending.promise);
    const view = render(
      <MlflowResources context={context} onUnauthorized={unauthorized} />,
    );
    await screen.findByText(snapshot.experiment.name);
    view.rerender(
      <MlflowResources
        context={{ ...context, ownerId: "B" }}
        onUnauthorized={unauthorized}
      />,
    );
    expect(screen.queryByText(snapshot.experiment.name)).toBeNull();
    await act(async () => pending.resolve(json({}, 401)));
    await screen.findByText("La sesión expiró. Inicia sesión nuevamente.");
    act(() => visibility(false));
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
