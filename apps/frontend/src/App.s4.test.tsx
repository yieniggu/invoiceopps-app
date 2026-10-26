import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
const policy = { version: "risk/v1 ?#é", manualReviewThreshold: 0.8 };
function http(role = "USER", platform = false) {
  const profile = {
    id: "user",
    name: "Persona",
    rut: "12345678-5",
    email: null,
    username: null,
    isPlatformAdministrator: platform,
    memberships: [
      { organization: { id: "org", name: "Academia", slug: "academy" }, role },
    ],
  };
  const groups = [
    {
      id: "group",
      name: "Equipo",
      organization: { id: "org", name: "Academia" },
      members: [],
    },
  ];
  const read = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ policies: [policy] }));
  const write = vi
    .fn<(init: RequestInit) => Promise<Response>>()
    .mockImplementation(async (init) => {
      const body = JSON.parse(String(init.body)) as {
        version?: string;
        manualReviewThreshold: number;
      };
      return json(
        {
          policy: {
            version: body.version ?? policy.version,
            manualReviewThreshold: body.manualReviewThreshold,
          },
        },
        init.method === "POST" ? 201 : 200,
      );
    });
  const profileRead = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ profile }));
  const logout = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => new Response(null, { status: 204 }));
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(input.toString(), "http://test.invalid");
      if (url.pathname === "/profile") return profileRead();
      if (url.pathname === "/groups") return json({ groups });
      if (url.pathname === "/platform/organizations")
        return json({ organizations: [] });
      if (url.pathname === "/auth/logout") return logout();
      if (url.pathname === "/auth/login") return json({});
      if (url.pathname.startsWith("/business-policies"))
        return init?.method ? write(init) : read();
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
  return { profile, read, write, profileRead, fetchMock, logout };
}
async function start(dashboard = false) {
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: dashboard ? "Ir a políticas" : /^Políticas$/,
    }),
  );
}
async function loaded() {
  await screen.findByRole("button", { name: `Editar ${policy.version}` });
}
function draft(value = "0.8", version = "  risk-v2  ") {
  fireEvent.change(screen.getByLabelText("Versión de política"), {
    target: { value: version },
  });
  fireEvent.change(screen.getByLabelText("Umbral de revisión manual (0 a 1)"), {
    target: { value },
  });
}
function submit() {
  fireEvent.submit(screen.getByRole("form", { name: "Crear política" }));
}
function group() {
  fireEvent.change(screen.getByLabelText("Propietario"), {
    target: { value: "org:group:group" },
  });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function editThreshold(value: string) {
  await loaded();
  fireEvent.click(
    screen.getByRole("button", { name: `Editar ${policy.version}` }),
  );
  fireEvent.change(screen.getByLabelText("Umbral de revisión manual (0 a 1)"), {
    target: { value },
  });
}
function submitEdit() {
  fireEvent.submit(screen.getByRole("form", { name: "Editar política" }));
}
function navigate(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("APP12 S4 session-owned policy writes", () => {
  it.each(["destination", "owner"])(
    "retains a pending PATCH and its intent across %s remounts with a loaded form",
    async (route) => {
      const api = http("ADMIN");
      const pending = deferred<Response>();
      api.write.mockReturnValueOnce(pending.promise);
      await start();
      await editThreshold("1");
      submitEdit();
      await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
      expect(api.write.mock.calls[0][0].method).toBe("PATCH");
      if (route === "destination") {
        navigate("Mi perfil");
        navigate("Políticas");
      } else {
        group();
        await loaded();
        fireEvent.change(screen.getByLabelText("Propietario"), {
          target: { value: "org:user:user" },
        });
      }
      try {
        // Both implementations have a loaded, editable policy here; the old one dispatches again.
        await editThreshold("0.2");
        await act(async () => submitEdit());
        expect(api.write).toHaveBeenCalledTimes(1);
        expect(
          screen.getByRole("form", { name: "Editar política" }),
        ).toBeTruthy();
        expect(
          screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
        ).toHaveProperty("value", "1");
        expect(
          screen.getByRole("button", { name: "Guardando política..." }),
        ).toHaveProperty("disabled", true);
      } finally {
        await act(async () =>
          pending.resolve(
            json({ policy: { ...policy, manualReviewThreshold: 1 } }),
          ),
        );
      }
    },
  );
  it("preserves unknown network outcome and intended values while away, and requires an agreeing GET before unlocking", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.write.mockImplementationOnce(async () => {
      await pending.promise;
      throw new TypeError("private network");
    });
    await start();
    await editThreshold("1");
    submitEdit();
    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
    navigate("Mi perfil");
    await act(async () => pending.resolve(json({})));
    navigate("Políticas");
    await editThreshold("0.2");
    await act(async () => submitEdit());
    expect(api.write).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Versión de política")).toHaveProperty(
      "value",
      policy.version,
    );
    expect(
      screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
    ).toHaveProperty("value", "1");
    expect(
      screen.getByRole("button", { name: "Guardar política" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText(/resultado es desconocido/i)).toBeTruthy();
    api.read.mockResolvedValueOnce(
      json({ policies: [{ ...policy, manualReviewThreshold: 1 }] }),
    );
    navigate("Consultar políticas");
    await screen.findByText(
      /La consulta actual coincide con la intención enviada/,
    );
    expect(
      screen.getByRole("button", { name: "Crear política" }),
    ).toHaveProperty("disabled", false);
    expect(api.write).toHaveBeenCalledTimes(1);
  });
  it("never releases an unknown write using a GET started while that write was still pending", async () => {
    const api = http();
    const pending = deferred<Response>();
    const reading = deferred<Response>();
    api.write.mockReturnValueOnce(pending.promise);
    await start();
    await editThreshold("1");
    submitEdit();
    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
    navigate("Mi perfil");
    api.read.mockReturnValueOnce(reading.promise);
    navigate("Políticas");
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve(json({}, 500)));
    await act(async () =>
      reading.resolve(
        json({ policies: [{ ...policy, manualReviewThreshold: 1 }] }),
      ),
    );
    await editThreshold("0.2");
    await act(async () => submitEdit());
    expect(api.write).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Guardar política" }),
    ).toHaveProperty("disabled", true);
    navigate("Consultar políticas");
    await screen.findByText(/Compara la lista actual/);
    expect(
      screen.getByRole("button", { name: "Guardar política" }),
    ).toHaveProperty("disabled", true);
  });
  it("records a late successful body for A without publishing it or clearing B draft, then shows A result on return", async () => {
    const api = http("ADMIN");
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.write.mockResolvedValueOnce(response);
    await start();
    await editThreshold("1");
    submitEdit();
    await waitFor(() => expect(parse).toHaveBeenCalled());
    group();
    await loaded();
    draft("0.2", "B-DRAFT");
    await act(async () =>
      body.resolve({ policy: { ...policy, manualReviewThreshold: 1 } }),
    );
    expect(screen.queryByText(/Política guardada/)).toBeNull();
    expect(screen.getByLabelText("Versión de política")).toHaveProperty(
      "value",
      "B-DRAFT",
    );
    fireEvent.change(screen.getByLabelText("Propietario"), {
      target: { value: "org:user:user" },
    });
    await loaded();
    await screen.findByText(/Política guardada:/);
    expect(api.write).toHaveBeenCalledTimes(1);
  });
  it("keeps a pending PATCH through failed logout without blocking legitimate logout", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.write.mockReturnValueOnce(pending.promise);
    api.logout.mockResolvedValueOnce(json({}, 500));
    await start();
    await editThreshold("1");
    submitEdit();
    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
    navigate("Salir");
    await screen.findByText(
      "No fue posible cerrar la sesión. Intenta nuevamente.",
    );
    try {
      await editThreshold("0.2");
      await act(async () => submitEdit());
      expect(api.logout).toHaveBeenCalledTimes(1);
      expect(api.write).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Salir" })).toHaveProperty(
        "disabled",
        false,
      );
      expect(
        screen.getByRole("button", { name: "Guardando política..." }),
      ).toHaveProperty("disabled", true);
    } finally {
      await act(async () =>
        pending.resolve(
          json({ policy: { ...policy, manualReviewThreshold: 1 } }),
        ),
      );
    }
  });
  it.each(["401", "body"])(
    "clears ledger on real logout/login of the same user and isolates old session %s",
    async (outcome) => {
      const api = http();
      const old = deferred<Response>();
      const current = deferred<Response>();
      const body = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      api.write
        .mockReturnValueOnce(
          outcome === "body" ? Promise.resolve(response) : old.promise,
        )
        .mockReturnValueOnce(current.promise);
      await start();
      await editThreshold("1");
      submitEdit();
      await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      navigate("Salir");
      await screen.findByRole("button", { name: "Iniciar sesión" });
      fireEvent.change(screen.getByLabelText("RUT"), {
        target: { value: "123456785" },
      });
      fireEvent.change(screen.getByLabelText("Contraseña"), {
        target: { value: "synthetic-password" },
      });
      navigate("Iniciar sesión");
      await screen.findByRole("navigation");
      navigate("Políticas");
      await editThreshold("0.2");
      submitEdit();
      await waitFor(() => expect(api.write).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (outcome === "body")
          body.resolve({ policy: { ...policy, manualReviewThreshold: 1 } });
        else old.resolve(json({}, 401));
      });
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(screen.queryByText(/Política guardada/)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Guardando política..." }),
      ).toHaveProperty("disabled", true);
      await act(async () =>
        current.resolve(
          json({ policy: { ...policy, manualReviewThreshold: 0.2 } }),
        ),
      );
      await screen.findByText(/Política guardada:/);
      expect(api.write).toHaveBeenCalledTimes(2);
    },
  );
  it("preserves an unsent draft across destination navigation without selecting it in another owner", async () => {
    const api = http("ADMIN");
    await start();
    await loaded();
    draft("0.4", "UNSENT");
    navigate("Mi perfil");
    navigate("Políticas");
    await loaded();
    expect(screen.getByLabelText("Versión de política")).toHaveProperty(
      "value",
      "UNSENT",
    );
    group();
    await loaded();
    expect(screen.getByLabelText("Versión de política")).toHaveProperty(
      "value",
      "",
    );
    expect(api.write).not.toHaveBeenCalled();
  });
});

describe("APP12 S4 policy HTTP workflow", () => {
  it("opens from Dashboard, scopes the exact GET and distinguishes loading from empty", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.read.mockReturnValueOnce(pending.promise);
    await start(true);
    await screen.findByText("Cargando políticas...");
    expect(
      screen.queryByText("No hay políticas para este propietario."),
    ).toBeNull();
    await act(async () => pending.resolve(json({ policies: [] })));
    await screen.findByText("No hay políticas para este propietario.");
    const call = api.fetchMock.mock.calls.find(([input]) =>
      input.toString().startsWith("/business-policies"),
    );
    expect(call?.[0]).toBe(
      "/business-policies?organizationId=org&ownerType=user&ownerId=user",
    );
    expect(call?.[1]?.credentials).toBe("same-origin");
  });
  it("does not query before authenticated context confirmation", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.profileRead.mockReturnValueOnce(pending.promise);
    render(<App />);
    expect(api.read).not.toHaveBeenCalled();
    await act(async () =>
      pending.resolve(json({ profile: { ...api.profile, memberships: [] } })),
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Políticas$/ }));
    await screen.findByText(
      "No tienes un contexto autorizado para consultar políticas.",
    );
    expect(api.read).not.toHaveBeenCalled();
  });
  it.each([403, 404, 500])(
    "keeps HTTP %s distinct from empty and supports read-only retry",
    async (status) => {
      const api = http();
      api.read.mockResolvedValueOnce(
        json({ message: "SQL secret stack" }, status),
      );
      await start();
      await screen.findByRole("alert");
      expect(
        screen.queryByText("No hay políticas para este propietario."),
      ).toBeNull();
      expect(document.body.textContent).not.toContain("SQL secret stack");
      expect(screen.queryByRole("form")).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Reintentar políticas" }),
      );
      await loaded();
      expect(api.write).not.toHaveBeenCalled();
    },
  );
  it("invalidates the session on a current 401", async () => {
    const api = http();
    api.read.mockResolvedValueOnce(json({}, 401));
    await start();
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(screen.queryByRole("navigation")).toBeNull();
  });
  it.each(["response", "401", "body"])(
    "isolates late owner A read %s from B",
    async (outcome) => {
      const api = http();
      const pending = deferred<Response>();
      const body = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      api.read.mockReturnValueOnce(
        outcome === "body" ? Promise.resolve(response) : pending.promise,
      );
      await start();
      await screen.findByText("Cargando políticas...");
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      group();
      await screen.findByText(policy.version);
      await act(async () => {
        if (outcome === "body")
          body.resolve({
            policies: [{ version: "A-PRIVATE", manualReviewThreshold: 0 }],
          });
        else
          pending.resolve(
            json(
              {
                policies: [{ version: "A-PRIVATE", manualReviewThreshold: 0 }],
              },
              outcome === "401" ? 401 : 200,
            ),
          );
      });
      expect(screen.queryByText("A-PRIVATE")).toBeNull();
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(screen.queryByRole("form")).toBeNull();
    },
  );
  it.each([0, 1])(
    "creates threshold %s without scaling or identity fields",
    async (threshold) => {
      const api = http();
      await start();
      await loaded();
      draft(String(threshold));
      submit();
      await screen.findByText(/Política guardada: risk-v2/);
      expect(api.write).toHaveBeenCalledTimes(1);
      expect(api.write.mock.calls[0][0]).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "risk-v2",
          manualReviewThreshold: threshold,
        }),
      });
      expect(api.read).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["", "NaN", "-0.1", "1.01", "80", "0,8", "0x1"])(
    "rejects threshold %j and preserves entered values",
    async (value) => {
      const api = http();
      await start();
      await loaded();
      draft(value);
      submit();
      expect(screen.getByRole("alert").textContent).toContain("entre 0 y 1");
      expect(
        screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
      ).toHaveProperty("value", value);
      expect(api.write).not.toHaveBeenCalled();
    },
  );
  it("edits only threshold, with immutable safely encoded version and explicit raw/percent display", async () => {
    const api = http();
    await start();
    await loaded();
    expect(screen.getByText(/0,8 \(80 %\)/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: `Editar ${policy.version}` }),
    );
    expect(screen.getByLabelText("Versión de política")).toHaveProperty(
      "readOnly",
      true,
    );
    fireEvent.change(
      screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
      { target: { value: "1" } },
    );
    fireEvent.submit(screen.getByRole("form", { name: "Editar política" }));
    await screen.findByText(/Política guardada:/);
    const call = api.fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(call?.[0]).toBe(
      `/business-policies/${encodeURIComponent(policy.version)}?organizationId=org&ownerType=user&ownerId=user`,
    );
    expect(call?.[1]?.body).toBe(JSON.stringify({ manualReviewThreshold: 1 }));
  });
  it("blocks duplicate submissions and retains draft on 409 without overwriting", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.write.mockReturnValueOnce(pending.promise);
    await start();
    await loaded();
    draft();
    submit();
    submit();
    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: "Guardando política..." }),
    ).toHaveProperty("disabled", true);
    await act(async () => pending.resolve(json({ message: "raw SQL" }, 409)));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "versión ya existe",
    );
    expect(screen.getByLabelText("Versión de política")).toHaveProperty(
      "value",
      "  risk-v2  ",
    );
    expect(api.write).toHaveBeenCalledTimes(1);
  });
  it("reports confirmed write separately from failed refresh and retries only GET", async () => {
    const api = http();
    await start();
    await loaded();
    api.read.mockResolvedValueOnce(json({}, 500));
    draft();
    submit();
    await screen.findByText(/Política guardada: risk-v2/);
    await screen.findByRole("button", { name: "Reintentar políticas" });
    expect(screen.getByText(/no repitas la operación/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar políticas" }),
    );
    await loaded();
    expect(api.write).toHaveBeenCalledTimes(1);
  });
  it("requires GET reconciliation for unknown network outcome, without automatic mutation retry", async () => {
    const api = http();
    api.write.mockRejectedValueOnce(new TypeError("network private"));
    await start();
    await loaded();
    draft();
    submit();
    await screen.findByText(/resultado es desconocido/i);
    expect(api.write).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Crear política" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("button", { name: "Consultar políticas" }),
    );
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    await screen.findByText(/Compara la lista actual/);
    expect(api.write).toHaveBeenCalledTimes(1);
  });
  it.each(["401", "body"])(
    "ignores a late mutation %s after switching owner and resets draft",
    async (outcome) => {
      const api = http("ADMIN");
      const pending = deferred<Response>();
      const body = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      api.write.mockReturnValueOnce(
        outcome === "body" ? Promise.resolve(response) : pending.promise,
      );
      await start();
      await loaded();
      draft();
      submit();
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      group();
      await loaded();
      draft("0.1", "B-DRAFT");
      await act(async () => {
        if (outcome === "body")
          body.resolve({
            policy: { version: "A-PRIVATE", manualReviewThreshold: 0 },
          });
        else pending.resolve(json({}, 401));
      });
      expect(screen.getByLabelText("Versión de política")).toHaveProperty(
        "value",
        "B-DRAFT",
      );
      expect(screen.queryByText(/Política guardada/)).toBeNull();
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(api.read).toHaveBeenCalledTimes(2);
    },
  );
  it.each([false, true])(
    "keeps group member read-only despite platform flag %s",
    async (platform) => {
      http("USER", platform);
      await start();
      await loaded();
      group();
      await screen.findByText(policy.version);
      expect(screen.getByText(/Solo lectura/)).toBeTruthy();
      expect(screen.queryByRole("form")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Editar / })).toBeNull();
    },
  );
  it("allows group management only with confirmed organization ADMIN and reconciles role changes/errors", async () => {
    const api = http("ADMIN");
    await start();
    await loaded();
    group();
    await loaded();
    api.profile.memberships[0].role = "USER";
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizar políticas" }),
    );
    await screen.findByText(/Solo lectura/);
    expect(screen.queryByRole("form")).toBeNull();
    api.profileRead.mockResolvedValueOnce(json({}, 500));
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizar políticas" }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByRole("form")).toBeNull();
    expect(api.write).not.toHaveBeenCalled();
  });
  it("revokes selected group on membership removal without fetching its policies", async () => {
    const api = http("ADMIN");
    await start();
    await loaded();
    group();
    await loaded();
    api.profile.memberships = [];
    const count = api.read.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizar políticas" }),
    );
    await screen.findByRole("alert");
    expect(api.read).toHaveBeenCalledTimes(count);
    expect(screen.queryByRole("form")).toBeNull();
  });
  it.each(["", "x".repeat(121)])(
    "rejects invalid version %j without dispatch",
    async (version) => {
      const api = http();
      await start();
      await loaded();
      draft("0.8", version);
      submit();
      expect(screen.getByRole("alert").textContent).toContain("1 a 120");
      expect(api.write).not.toHaveBeenCalled();
    },
  );
  it("revalidates organization role before mutation, not only when loading", async () => {
    const api = http("ADMIN");
    await start();
    await loaded();
    group();
    await loaded();
    draft();
    api.profile.memberships[0].role = "USER";
    submit();
    await screen.findByRole("alert");
    expect(screen.queryByRole("form")).toBeNull();
    expect(api.write).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404])(
    "handles current mutation HTTP %s without raw server messages or retry",
    async (status) => {
      const api = http();
      api.write.mockResolvedValueOnce(
        json({ message: "private-provider-stack" }, status),
      );
      await start();
      await loaded();
      draft();
      submit();
      if (status === 401)
        await screen.findByRole("button", { name: "Iniciar sesión" });
      else {
        await screen.findAllByRole("alert");
        expect(document.body.textContent).not.toContain(
          "private-provider-stack",
        );
      }
      expect(api.write).toHaveBeenCalledTimes(1);
    },
  );
  it("aborts obsolete reads and ignores finalization of A while B has a mutation pending", async () => {
    const api = http("ADMIN");
    await start();
    await loaded();
    const a = deferred<Response>();
    const b = deferred<Response>();
    api.write.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    draft();
    submit();
    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
    group();
    await loaded();
    expect(screen.getByLabelText("Versión de política")).toHaveProperty(
      "value",
      "",
    );
    draft("1", "B-DRAFT");
    submit();
    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(2));
    await act(async () =>
      a.resolve(
        json(
          { policy: { version: "risk-v2", manualReviewThreshold: 0.8 } },
          201,
        ),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Guardando política..." }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByText(/Política guardada/)).toBeNull();
    await act(async () =>
      b.resolve(
        json({ policy: { version: "B-DRAFT", manualReviewThreshold: 1 } }, 201),
      ),
    );
    await screen.findByText(/Política guardada: B-DRAFT/);
    const pending = deferred<Response>();
    api.read.mockReturnValueOnce(pending.promise);
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizar políticas" }),
    );
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(4));
    const readCall = api.fetchMock.mock.calls
      .filter(([input]) => input.toString().startsWith("/business-policies"))
      .at(-1);
    const signal = readCall?.[1]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "Mi perfil" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(json({}, 401)));
    expect(screen.getByRole("navigation")).toBeTruthy();
  });
  it("clears selected policy across organizations and queries only the new authoritative context", async () => {
    const api = http();
    api.profile.memberships.push({
      organization: { id: "org-B", name: "Academia B", slug: "b" },
      role: "USER",
    });
    await start();
    await loaded();
    fireEvent.click(
      screen.getByRole("button", { name: `Editar ${policy.version}` }),
    );
    fireEvent.change(screen.getByLabelText("Propietario"), {
      target: { value: "org-B:user:user" },
    });
    await loaded();
    expect(screen.getByRole("form", { name: "Crear política" })).toBeTruthy();
    expect(screen.getByLabelText("Versión de política")).toHaveProperty(
      "value",
      "",
    );
    const calls = api.fetchMock.mock.calls.filter(([input]) =>
      input.toString().startsWith("/business-policies"),
    );
    expect(calls.at(-1)?.[0]).toBe(
      "/business-policies?organizationId=org-B&ownerType=user&ownerId=user",
    );
  });
});
