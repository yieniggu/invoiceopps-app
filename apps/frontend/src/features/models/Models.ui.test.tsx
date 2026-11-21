import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/renderApp";
import { uuid } from "../../test/ids";
import { contabilidad, norte, sur } from "../../test/invoices";
import {
  deferred,
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  NO_PERMISSIONS,
  profileFixture,
  type RecordedRequest,
  type RouteHandler,
} from "../../test/transport";
import type { Deployment, DeploymentList, ModelCatalog } from "./types";

const DEPLOY = { ...NO_PERMISSIONS, deployModels: true };
const NORTE_ON = { ...norte, mlEnabled: true };
const MODELS = "/api/v1/models";
const DEPLOYMENTS = "/api/v1/deployments";

const profile = (
  options: {
    deploy?: boolean;
    enabled?: boolean;
    groups?: boolean;
    groupDeploy?: boolean;
  } = {},
) => {
  const {
    deploy = true,
    enabled = true,
    groups = false,
    groupDeploy = false,
  } = options;
  return profileFixture({
    memberships: [
      membership(enabled ? NORTE_ON : norte, "USER", {
        permissions: deploy ? DEPLOY : NO_PERMISSIONS,
        groups: groups
          ? [
              {
                group: contabilidad,
                effective: groupDeploy ? DEPLOY : NO_PERMISSIONS,
              },
            ]
          : [],
      }),
    ],
  });
};

const catalog = (): ModelCatalog => ({
  workspace: `org-${norte.id}`,
  mlflowUrl: `https://mlflow.example.test/?context=org-${norte.id}`,
  truncated: false,
  models: [
    {
      name: "invoice-risk",
      versions: [
        {
          version: "3",
          runId: "run-3",
          createdAt: "2026-11-02T12:00:00.000Z",
          gateStatus: "passed",
        },
        { version: "2", runId: "run-2", createdAt: null, gateStatus: null },
      ],
    },
  ],
});

const deployment = (
  n: number,
  overrides: Partial<Deployment> = {},
): Deployment => ({
  id: uuid(700 + n),
  organizationId: norte.id,
  groupId: null,
  workspace: `org-${norte.id}`,
  registeredModel: "invoice-risk",
  version: String(n),
  runId: `run-${n}`,
  status: "ACTIVE",
  inferenceEnabled: false,
  loaded: true,
  gate: {
    passed: true,
    metrics: {
      auc: 0.82,
      dummyAuc: 0.5,
      lift: 0.32,
      minAuc: 0.7,
      minLift: 0.02,
      validationRows: 4000,
    },
    reasons: [],
    featureSchemaVersion: "invoice-features-v2",
    checkedAt: "2026-11-03T10:00:00.000Z",
  },
  createdByUserId: "u",
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  ...overrides,
});

const list = (
  items: Deployment[],
  extra: Partial<DeploymentList> = {},
): DeploymentList => ({
  items,
  limits: {
    activeCount: items.filter((item) => item.status === "ACTIVE").length,
    maxActive: 3,
    maxChecksPerHour: 10,
  },
  modelApiAvailable: true,
  ...extra,
});

interface Options {
  profile?: () => Record<string, unknown>;
  models?: () => Response | Promise<Response>;
  deployments?: () => Response | Promise<Response>;
  post?: (request: RecordedRequest) => Response | Promise<Response>;
  patch?: (request: RecordedRequest) => Response | Promise<Response>;
  del?: (request: RecordedRequest) => Response | Promise<Response>;
}

function setup(options: Options = {}) {
  const state = { deployments: [deployment(2)] as Deployment[] };
  const find = (n: number) =>
    state.deployments.find((item) => item.id === uuid(700 + n));
  const routes: Record<string, RouteHandler> = {
    "GET /api/v1/auth/profile": () =>
      jsonResponse({ profile: (options.profile ?? profile)() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [`GET ${MODELS}`]: options.models ?? (() => jsonResponse(catalog())),
    [`GET ${DEPLOYMENTS}`]:
      options.deployments ?? (() => jsonResponse(list(state.deployments))),
    [`POST ${DEPLOYMENTS}`]:
      options.post ??
      ((request) => {
        const body = request.body as { version: string };
        const created = deployment(Number(body.version));
        state.deployments = [created, ...state.deployments];
        return jsonResponse({ deployment: created }, 201);
      }),
  };
  for (let n = 0; n < 10; n += 1) {
    routes[`PATCH ${DEPLOYMENTS}/${uuid(700 + n)}`] =
      options.patch ??
      ((request) => {
        const enabled = (request.body as { inferenceEnabled: boolean })
          .inferenceEnabled;
        state.deployments = state.deployments.map((item) =>
          item.id === uuid(700 + n)
            ? { ...item, inferenceEnabled: enabled }
            : item,
        );
        return jsonResponse({ deployment: find(n) });
      });
    routes[`DELETE ${DEPLOYMENTS}/${uuid(700 + n)}`] =
      options.del ??
      (() => {
        state.deployments = state.deployments.map((item) =>
          item.id === uuid(700 + n)
            ? { ...item, status: "INACTIVE", inferenceEnabled: false }
            : item,
        );
        return jsonResponse({ deployment: find(n) });
      });
  }
  return { transport: mockTransport(routes), state };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const open = async (route = "/models") => {
  const view = renderApp({ route });
  await screen.findByRole("heading", { level: 1, name: "Modelos" });
  return view;
};

const deployButton = (version: string) =>
  screen.findByRole("button", {
    name: `Desplegar invoice-risk versión ${version}`,
  });

describe("MLOPS-05 section visibility", () => {
  it("hides the entry and answers like an unknown URL while the organization has it off", async () => {
    setup({ profile: () => profile({ enabled: false }) });
    renderApp({ route: "/models" });
    await screen.findByRole("heading", { name: "Página no encontrada" });
    expect(screen.queryByRole("link", { name: "Modelos" })).toBeNull();
  });

  it("offers «Modelos» in the navigation when an organization turned it on", async () => {
    setup();
    renderApp({ route: "/dashboard" });
    const link = await screen.findByRole("link", { name: "Modelos" });
    expect(link.getAttribute("href")).toBe("/models");
  });
});

describe("MLOPS-05 models and deployments", () => {
  it("lists models and deployments of the context with the MLflow link", async () => {
    const { transport } = setup();
    await open();

    expect(await deployButton("3")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Abrir MLflow/ });
    expect(link.getAttribute("href")).toBe(
      `https://mlflow.example.test/?context=org-${norte.id}`,
    );
    expect(link.getAttribute("rel")).toContain("noopener");
    const table = await screen.findByRole("table", {
      name: "Despliegues del contexto",
    });
    expect(within(table).getByText(/invoice-risk · versión 2/)).toBeTruthy();
    expect(within(table).getByText("Activo")).toBeTruthy();
    expect(screen.getByText("1/3 activos")).toBeTruthy();
    const sent = transport.calls(`GET ${MODELS}`)[0]!;
    expect(new URLSearchParams(sent.search).get("organizationId")).toBe(
      norte.id,
    );
    expect(new URLSearchParams(sent.search).has("workspace")).toBe(false);
  });

  it("shows no «Desplegar» button and a locked switch without the permission", async () => {
    setup({ profile: () => profile({ deploy: false }) });
    await open();
    await screen.findByRole("table", { name: "Modelos registrados" });
    expect(screen.queryByRole("button", { name: /^Desplegar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Quitar/ })).toBeNull();
    const toggle = screen.getByRole("switch", { name: /versión 2/ });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("title")).toMatch(/Desplegar modelos/);
  });

  it("deploys a passing version and shows the result", async () => {
    const { transport } = setup();
    await open();
    fireEvent.click(await deployButton("3"));

    const result = await screen.findByRole("status", {
      name: "Resultado del despliegue",
    });
    expect(within(result).getByText("Modelo aprobado")).toBeTruthy();
    expect(within(result).getByText(/AUC 0,82 \(mínimo 0,70\)/)).toBeTruthy();
    const posted = transport.calls(`POST ${DEPLOYMENTS}`)[0]!;
    expect(posted.body).toEqual({
      organizationId: norte.id,
      groupId: null,
      registeredModel: "invoice-risk",
      version: "3",
    });
    // The list refetched and now holds the version, so it cannot be repeated.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Desplegar invoice-risk versión 3" })
          .getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    expect(
      screen
        .getByRole("button", { name: "Desplegar invoice-risk versión 3" })
        .getAttribute("title"),
    ).toBe("Ya desplegada");
  });

  it("explains a rejected version with the translated reasons", async () => {
    const rejected = deployment(3, {
      status: "FAILED",
      gate: {
        featureSchemaVersion: "invoice-features-v2",
        checkedAt: "2026-11-03T10:00:00.000Z",
        passed: false,
        metrics: {
          auc: 0.61,
          dummyAuc: 0.5,
          lift: 0.11,
          minAuc: 0.7,
          minLift: 0.02,
          validationRows: 4000,
        },
        reasons: [
          {
            code: "AUC_BELOW_MIN",
            message: "AUC 0.61 is below the minimum 0.70",
            detail: { auc: 0.61, minAuc: 0.7 },
          },
          {
            code: "SIGNATURE_MISMATCH",
            message: "x",
            detail: { expected: ["a", "b"], found: ["a"] },
          },
          { code: "SOMETHING_NEW", message: "x", detail: {} },
        ],
      },
    });
    setup({ post: () => jsonResponse({ deployment: rejected }, 201) });
    await open();
    fireEvent.click(await deployButton("3"));

    const result = await screen.findByRole("alert", {
      name: "Resultado del despliegue",
    });
    expect(within(result).getByText("Modelo rechazado")).toBeTruthy();
    expect(
      within(result).getByText("AUC 0,61 en validación oficial, mínimo 0,70"),
    ).toBeTruthy();
    expect(
      within(result).getByText(/Las columnas del modelo no coinciden/),
    ).toBeTruthy();
    expect(within(result).getByText(/código SOMETHING_NEW/)).toBeTruthy();
  });

  it("disables deploying with a reason when the scope is full", async () => {
    const full = [deployment(1), deployment(2), deployment(4)];
    const { transport } = setup({
      deployments: () => jsonResponse(list(full)),
    });
    await open();
    const button = await deployButton("3");
    await waitFor(() =>
      expect(button.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(button.getAttribute("title")).toBe("Máximo de 3 activos");
    fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(transport.calls(`POST ${DEPLOYMENTS}`)).toHaveLength(0);
  });

  it("shows the progress of a slow check and the limit errors", async () => {
    const pending = deferred<Response>();
    const { transport } = setup({ post: () => pending.promise });
    await open();
    fireEvent.click(await deployButton("3"));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Desplegar invoice-risk versión 3" })
          .getAttribute("aria-busy"),
      ).toBe("true"),
    );
    expect(
      screen
        .getByRole("button", { name: "Desplegar invoice-risk versión 3" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByText(/Verificando/)).toBeNull();
    pending.resolve(errorResponse(429, "RATE_LIMITED"));
    expect(
      await screen.findByText("Demasiadas verificaciones. Espera un momento."),
    ).toBeTruthy();
    expect(transport.calls(`POST ${DEPLOYMENTS}`)).toHaveLength(1);
  });

  it("turns scoring on and off with a switch", async () => {
    const { transport } = setup();
    await open();
    const toggle = await screen.findByRole("switch", { name: /versión 2/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: /versión 2/ })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    const patched = transport.calls(`PATCH ${DEPLOYMENTS}/${uuid(702)}`)[0]!;
    expect(patched.body).toEqual({ inferenceEnabled: true });
    expect(new URLSearchParams(patched.search).get("organizationId")).toBe(
      norte.id,
    );
    expect(await screen.findByText(/Inferencia activada/)).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: /versión 2/ }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: /versión 2/ })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });

  it("reports a toggle that the server refuses and keeps the list usable", async () => {
    setup({ patch: () => errorResponse(503, "SERVICE_UNAVAILABLE") });
    await open();
    fireEvent.click(await screen.findByRole("switch", { name: /versión 2/ }));
    expect(
      await screen.findByText("Servicio de modelos no disponible."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: /versión 2/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("asks before removing a deployment and keeps it in the history", async () => {
    const { transport } = setup();
    await open();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar invoice-risk versión 2",
      }),
    );
    expect(transport.calls(`DELETE ${DEPLOYMENTS}/${uuid(702)}`)).toHaveLength(
      0,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmar: quitar" }));

    expect(await screen.findByText("Inactivo")).toBeTruthy();
    expect(transport.calls(`DELETE ${DEPLOYMENTS}/${uuid(702)}`)).toHaveLength(
      1,
    );
    expect(screen.queryByRole("button", { name: /^Quitar/ })).toBeNull();
  });

  it("flags a quarantined deployment and a model the service lost", async () => {
    const items = [
      deployment(1, { status: "QUARANTINED" }),
      deployment(2, { loaded: false }),
    ];
    setup({ deployments: () => jsonResponse(list(items)) });
    await open();
    expect(await screen.findByText("En cuarentena")).toBeTruthy();
    // One signal each: the badge says quarantined, an icon says not loaded.
    expect(
      screen.getByRole("img", { name: "No cargado en el servicio" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Quítalo y vuelve a desplegarlo/)).toBeNull();
    expect(screen.queryByText(/Se recarga al activar/)).toBeNull();
  });
});

describe("MLOPS-05 states and failures", () => {
  it("shows loading, then empty states", async () => {
    const slow = deferred<Response>();
    setup({
      models: () => slow.promise,
      deployments: () => jsonResponse(list([])),
    });
    await open();
    expect((await screen.findAllByTestId("skeleton")).length).toBeGreaterThan(
      0,
    );
    // Loading is never visible text; only the hidden announcement says it.
    expect(
      screen
        .queryAllByText(/Cargando/)
        .every((node) => node.classList.contains("visually-hidden")),
    ).toBe(true);
    expect(await screen.findByText("Sin despliegues")).toBeTruthy();
    slow.resolve(jsonResponse({ ...catalog(), models: [] }));
    expect(await screen.findByText("Sin modelos registrados")).toBeTruthy();
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("keeps the deployments when MLflow is down and offers a retry", async () => {
    let calls = 0;
    setup({
      models: () => {
        calls += 1;
        return calls === 1
          ? errorResponse(503, "SERVICE_UNAVAILABLE")
          : jsonResponse(catalog());
      },
    });
    await open();
    expect(
      await screen.findByText(/No fue posible cargar los modelos/),
    ).toBeTruthy();
    expect(
      await screen.findByRole("table", { name: "Despliegues del contexto" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar modelos" }));
    expect(await deployButton("3")).toBeTruthy();
  });

  it("keeps the models when the deployments fail and warns when the model service is unreachable", async () => {
    setup({ deployments: () => errorResponse(503, "RETRYABLE_CONFLICT") });
    await open();
    expect(
      await screen.findByText(/No fue posible cargar los despliegues/),
    ).toBeTruthy();
    expect(
      await screen.findByRole("table", { name: "Modelos registrados" }),
    ).toBeTruthy();
  });

  it("warns that states may be outdated when the Model API could not be reached", async () => {
    setup({
      deployments: () =>
        jsonResponse(list([deployment(2)], { modelApiAvailable: false })),
    });
    await open();
    expect(
      await screen.findByRole("status", {
        name: "Servicio de modelos no disponible",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Servicio de modelos no disponible.")).toBeNull();
  });

  it("switches context without leaking rows of the other one, and switching back works", async () => {
    const groupItem = deployment(5, {
      groupId: contabilidad.id,
      registeredModel: "group-risk",
    });
    const slowGroup = deferred<Response>();
    let groupReads = 0;
    const isGroup = (search: string) =>
      new URLSearchParams(search).get("groupId") === contabilidad.id;
    const { transport } = setup({
      profile: () => profile({ groups: true, groupDeploy: false }),
    });
    transport.routes[`GET ${DEPLOYMENTS}`] = ({ search }) => {
      if (!isGroup(search)) return jsonResponse(list([deployment(2)]));
      groupReads += 1;
      return groupReads === 1
        ? slowGroup.promise
        : jsonResponse(list([groupItem]));
    };
    transport.routes[`GET ${MODELS}`] = ({ search }) =>
      isGroup(search)
        ? jsonResponse({
            ...catalog(),
            models: [
              {
                name: "group-risk",
                versions: [
                  {
                    version: "9",
                    runId: null,
                    createdAt: null,
                    gateStatus: null,
                  },
                ],
              },
            ],
          })
        : jsonResponse(catalog());

    await open();
    const select = await screen.findByLabelText("Contexto");
    expect(select.querySelectorAll("option")).toHaveLength(2);
    const deploymentsOf = () =>
      screen.queryByRole("table", { name: "Despliegues del contexto" });
    expect(await screen.findByText(/invoice-risk · versión 2/)).toBeTruthy();

    fireEvent.change(select, {
      target: { value: `group:${norte.id}:${contabilidad.id}` },
    });
    await waitFor(() => expect(groupReads).toBe(1));
    expect(window.location.search).toContain(`groupId=${contabilidad.id}`);
    // The group's read is still out: nothing of the organization is on screen.
    expect(screen.queryByText(/invoice-risk/)).toBeNull();
    expect(deploymentsOf()).toBeNull();
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);

    slowGroup.resolve(jsonResponse(list([groupItem])));
    expect(await screen.findByText(/group-risk · versión 5/)).toBeTruthy();
    expect(screen.queryByText(/invoice-risk/)).toBeNull();
    // Without the group flag the group context hides the deploy buttons.
    expect(screen.queryByRole("button", { name: /^Desplegar/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("Contexto"), {
      target: { value: `org:${norte.id}` },
    });
    expect(await screen.findByText(/invoice-risk · versión 2/)).toBeTruthy();
    expect(screen.queryByText(/group-risk/)).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: "Desplegar invoice-risk versión 3",
      }),
    ).toBeTruthy();
    expect(window.location.search).toContain(`organizationId=${norte.id}`);
    expect(window.location.search).not.toContain("groupId");
  });

  it("ignores contexts of organizations that have it off and never asks for them", async () => {
    const { transport } = setup({
      profile: () =>
        profileFixture({
          memberships: [
            membership(norte, "USER", {
              permissions: DEPLOY,
              groups: [{ group: contabilidad, effective: DEPLOY }],
            }),
            membership({ ...sur, mlEnabled: true }, "USER", {
              permissions: DEPLOY,
            }),
          ],
        }),
    });
    await open(`/models?organizationId=${norte.id}`);
    // Only Sur qualifies: a single context, so no selector and its label shows.
    expect(
      await screen.findByText("Organización · Instituto Sur"),
    ).toBeTruthy();
    await screen.findByRole("table", { name: "Despliegues del contexto" });
    expect(screen.queryByLabelText("Contexto")).toBeNull();
    expect(screen.queryByText(/Academia Norte/)).toBeNull();
    // The URL asked for Norte (off): nothing of it is read, only Sur is.
    const asked = [
      ...transport.calls(`GET ${MODELS}`),
      ...transport.calls(`GET ${DEPLOYMENTS}`),
    ].map((request) =>
      new URLSearchParams(request.search).get("organizationId"),
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((id) => id === sur.id)).toBe(true);
    expect(asked.includes(norte.id) || transport.unexpected.length > 0).toBe(
      false,
    );
  });

  it("lists only the contexts of organizations that have it on", async () => {
    setup({
      profile: () =>
        profileFixture({
          memberships: [
            membership(NORTE_ON, "USER", { permissions: DEPLOY }),
            membership({ ...sur, mlEnabled: true }, "USER", {
              permissions: DEPLOY,
            }),
            membership(
              { id: uuid(103), name: "Apagada", mlEnabled: false },
              "USER",
              { permissions: DEPLOY },
            ),
          ],
        }),
    });
    await open();
    const select = await screen.findByLabelText("Contexto");
    expect(
      [...select.querySelectorAll("option")].map(
        (option) => option.textContent,
      ),
    ).toEqual([
      "Organización · Academia Norte",
      "Organización · Instituto Sur",
    ]);
  });
});

const alerts = () => screen.queryAllByRole("alert");
const announcer = () =>
  screen
    .getAllByRole("status")
    .find((element) => element.classList.contains("visually-hidden"));

describe("MLOPS-05 blocked deploy buttons", () => {
  it("blocks silently while the list loads and offers a retry when it fails (CR-556)", async () => {
    const slow = deferred<Response>();
    let calls = 0;
    setup({
      deployments: () => {
        calls += 1;
        return calls === 1 ? slow.promise : jsonResponse(list([deployment(2)]));
      },
    });
    await open();
    const button = await deployButton("3");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    // Loading is never visible text; only the hidden announcement says it.
    expect(
      screen
        .queryAllByText(/Cargando/)
        .every((node) => node.classList.contains("visually-hidden")),
    ).toBe(true);
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);

    slow.resolve(errorResponse(500, "INTERNAL_ERROR"));
    const retry = await screen.findByRole("button", {
      name: "Reintentar despliegues",
    });
    // Still blocked, still no reason text: the retry is the signal.
    expect((await deployButton("3")).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(screen.queryByText("Ya desplegada")).toBeNull();

    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Desplegar invoice-risk versión 3" })
          .getAttribute("aria-disabled"),
      ).toBeNull(),
    );
  });

  it("exposes why a version cannot be deployed through aria-describedby (CR-557)", async () => {
    setup({
      deployments: () =>
        jsonResponse(list([deployment(3), deployment(1), deployment(4)])),
    });
    await open();
    const live = await deployButton("3");
    await waitFor(() =>
      expect(live.getAttribute("aria-describedby")).toBeTruthy(),
    );
    const reason = (button: HTMLElement) =>
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent;
    // Already live wins over the full scope for that version.
    expect(reason(live)).toBe("Ya desplegada");

    const other = await deployButton("2");
    expect(reason(other)).toBe("Máximo de 3 activos");
    expect(
      document.getElementById(other.getAttribute("aria-describedby")!)
        ?.className,
    ).toContain("visually-hidden");
  });

  it("shows a short line next to the counter when the scope is full (CR-557)", async () => {
    setup({
      deployments: () =>
        jsonResponse(list([deployment(1), deployment(2), deployment(4)])),
    });
    await open();
    const counter = await screen.findByText("3/3 activos");
    expect(counter.parentElement?.textContent).toContain("Máximo alcanzado");
  });

  it("shows no such line while there is room, and no describedby on a free version", async () => {
    setup();
    await open();
    const button = await deployButton("3");
    await screen.findByText("1/3 activos");
    expect(screen.queryByText("Máximo alcanzado")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("MLOPS-05 one result surface and focus", () => {
  it("keeps a single result or error at a time across consecutive actions (CR-558)", async () => {
    let patches = 0;
    setup({
      patch: () => {
        patches += 1;
        return errorResponse(503, "SERVICE_UNAVAILABLE");
      },
      del: () => errorResponse(409, "CONFLICT"),
    });
    await open();

    // 1. A toggle fails: one alert.
    fireEvent.click(await screen.findByRole("switch", { name: /versión 2/ }));
    expect(
      await screen.findByText("Servicio de modelos no disponible."),
    ).toBeTruthy();
    expect(alerts()).toHaveLength(1);
    expect(patches).toBe(1);

    // 2. A deploy starts: the old error is gone before the result arrives.
    fireEvent.click(await deployButton("3"));
    const result = await screen.findByRole("status", {
      name: "Resultado del despliegue",
    });
    expect(result).toBeTruthy();
    expect(alerts()).toHaveLength(0);
    expect(screen.queryByText("Servicio de modelos no disponible.")).toBeNull();

    // 3. A removal fails: the deploy result is replaced by that one error.
    fireEvent.click(
      screen.getByRole("button", { name: "Quitar invoice-risk versión 2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmar: quitar" }));
    expect(await screen.findByText("El despliegue cambió.")).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: "Resultado del despliegue" }),
    ).toBeNull();
    expect(alerts()).toHaveLength(1);

    // 4. Another toggle starts: that error is cleared at once.
    fireEvent.click(screen.getByRole("switch", { name: /versión 2/ }));
    await waitFor(() => expect(patches).toBe(2));
    expect(screen.queryByText("El despliegue cambió.")).toBeNull();
  });

  it("moves focus to the Deployments heading after a successful deploy and removal (CR-559)", async () => {
    setup();
    await open();
    const heading = () => screen.getByRole("heading", { name: "Despliegues" });
    fireEvent.click(await deployButton("3"));
    await screen.findByRole("status", { name: "Resultado del despliegue" });
    await waitFor(() => expect(document.activeElement).toBe(heading()));

    (document.activeElement as HTMLElement).blur();
    fireEvent.click(
      screen.getByRole("button", { name: "Quitar invoice-risk versión 2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmar: quitar" }));
    await waitFor(() => expect(screen.getAllByText("Inactivo").length).toBe(1));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
  });

  it("keeps focus where it is when an action fails (CR-559)", async () => {
    setup({ patch: () => errorResponse(503, "SERVICE_UNAVAILABLE") });
    await open();
    const toggle = await screen.findByRole("switch", { name: /versión 2/ });
    toggle.focus();
    fireEvent.click(toggle);
    await screen.findByText("Servicio de modelos no disponible.");
    expect(document.activeElement).toBe(toggle);
  });

  it("locks the removal trigger with aria-disabled while it runs, keeping focus (CR-559)", async () => {
    const pending = deferred<Response>();
    const { transport } = setup({ del: () => pending.promise });
    await open();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar invoice-risk versión 2",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmar: quitar" }));
    const trigger = await screen.findByRole("button", {
      name: "Quitar invoice-risk versión 2",
    });
    await waitFor(() => expect(trigger.getAttribute("aria-busy")).toBe("true"));
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(
      screen.queryByRole("button", { name: "Confirmar: quitar" }),
    ).toBeNull();
    expect(transport.calls(`DELETE ${DEPLOYMENTS}/${uuid(702)}`)).toHaveLength(
      1,
    );
    pending.resolve(jsonResponse({ deployment: deployment(2) }));
  });
});

describe("MLOPS-05 overlapping actions (CR-576)", () => {
  const deployBusy = () =>
    screen
      .getByRole("button", { name: "Desplegar invoice-risk versión 3" })
      .getAttribute("aria-busy");

  it("ignores a switch toggled while a deploy runs and clears the deploy spinner when it settles", async () => {
    const gate = deferred<Response>();
    const { transport } = setup({ post: () => gate.promise });
    await open();
    fireEvent.click(await deployButton("3"));
    await waitFor(() => expect(deployBusy()).toBe("true"));

    const toggle = screen.getByRole("switch", { name: /versión 2/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(transport.calls(`PATCH ${DEPLOYMENTS}/${uuid(702)}`)).toHaveLength(
      0,
    );
    // The pending deploy is still shown as running: nothing reset it.
    expect(deployBusy()).toBe("true");

    gate.resolve(jsonResponse({ deployment: deployment(3) }, 201));
    await screen.findByRole("status", { name: "Resultado del despliegue" });
    await waitFor(() => expect(deployBusy()).toBeNull());
    expect(
      screen
        .getByRole("switch", { name: /versión 2/ })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("ignores a deploy or removal started while a switch is changing and clears its spinner when it settles", async () => {
    const gate = deferred<Response>();
    const { transport } = setup({ patch: () => gate.promise });
    await open();
    const toggle = await screen.findByRole("switch", { name: /versión 2/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-busy")).toBe("true"));

    fireEvent.click(
      screen.getByRole("button", { name: "Desplegar invoice-risk versión 3" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Quitar invoice-risk versión 2" }),
    );
    expect(transport.calls(`POST ${DEPLOYMENTS}`)).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Confirmar: quitar" }),
    ).toBeNull();
    expect(deployBusy()).toBeNull();

    gate.resolve(
      jsonResponse({ deployment: deployment(2, { inferenceEnabled: true }) }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: /versión 2/ })
          .getAttribute("aria-busy"),
      ).toBeNull(),
    );
  });
});

describe("MLOPS-05 announcements and busy sections", () => {
  it("announces the pending and the finished toggle in one hidden live region (CR-562)", async () => {
    const pending = deferred<Response>();
    setup({
      patch: async () => pending.promise,
    });
    await open();
    expect(announcer()?.textContent).toBe("");
    fireEvent.click(await screen.findByRole("switch", { name: /versión 2/ }));
    await waitFor(() =>
      expect(announcer()?.textContent).toBe(
        "Cambiando inferencia de invoice-risk versión 2",
      ),
    );
    pending.resolve(
      jsonResponse({ deployment: deployment(2, { inferenceEnabled: true }) }),
    );
    await waitFor(() =>
      expect(announcer()?.textContent).toBe(
        "Inferencia activada: invoice-risk versión 2",
      ),
    );
    // The same words are not painted anywhere else.
    expect(
      screen
        .getAllByText(/Inferencia activada/)
        .every((node) => node.classList.contains("visually-hidden")),
    ).toBe(true);
  });

  it("marks the sections it replaces as busy while they refresh (CR-562)", async () => {
    const reload = deferred<Response>();
    let reads = 0;
    setup({
      deployments: () => {
        reads += 1;
        return reads === 1
          ? jsonResponse(list([deployment(2)]))
          : reload.promise;
      },
    });
    await open();
    await screen.findByRole("table", { name: "Despliegues del contexto" });
    const section = () =>
      screen.getByRole("heading", { name: "Despliegues" }).closest("section")!;
    expect(section().getAttribute("aria-busy")).toBeNull();
    fireEvent.click(await screen.findByRole("switch", { name: /versión 2/ }));
    await waitFor(() =>
      expect(section().getAttribute("aria-busy")).toBe("true"),
    );
    reload.resolve(
      jsonResponse(list([deployment(2, { inferenceEnabled: true })])),
    );
    await waitFor(() => expect(section().getAttribute("aria-busy")).toBeNull());
  });
});

describe("MLOPS-05 loading announcements (CR-583)", () => {
  it("announces the initial load once, in hidden text without an ellipsis, and marks only the skeleton busy", async () => {
    const gate = deferred<Response>();
    setup({ deployments: () => gate.promise });
    await open();
    const status = await screen.findByText("Cargando despliegues");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.className).toContain("visually-hidden");
    expect(screen.queryByText(/Cargando despliegues(\.\.\.|…)/)).toBeNull();
    gate.resolve(jsonResponse(list([deployment(2)])));
    await waitFor(() =>
      expect(screen.queryByText("Cargando despliegues")).toBeNull(),
    );
  });

  it("does not mark the list busy on every background poll of a CHECKING deployment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      const reload = deferred<Response>();
      setup({
        deployments: () => {
          reads += 1;
          return reads === 2
            ? reload.promise
            : jsonResponse(list([deployment(2, { status: "CHECKING" })]));
        },
      });
      await open();
      await screen.findByRole("table", { name: "Despliegues del contexto" });
      const section = () =>
        screen
          .getByRole("heading", { name: "Despliegues" })
          .closest("section")!;
      await vi.advanceTimersByTimeAsync(2_100);
      await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
      // A poll is in flight: the list is not announced as busy.
      expect(section().getAttribute("aria-busy")).toBeNull();
      reload.resolve(
        jsonResponse(list([deployment(2, { status: "CHECKING" })])),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stalled deployment polling (CR-591)", () => {
  it("shows one refresh control, «Reintentar», when the poll fails, not the stalled icon too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let failing = false;
      setup({
        deployments: () =>
          failing
            ? errorResponse(500, "INTERNAL")
            : jsonResponse(list([deployment(2, { status: "CHECKING" })])),
      });
      await open();
      await screen.findByRole("table", { name: "Despliegues del contexto" });
      failing = true;
      await vi.advanceTimersByTimeAsync(2_100);
      await screen.findByRole("button", { name: "Reintentar despliegues" });
      expect(
        screen.queryByRole("button", { name: "Actualizar despliegues" }),
      ).toBeNull();
      expect(
        screen.getAllByRole("button", {
          name: /Reintentar despliegues|Actualizar despliegues/,
        }),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MLOPS-05 minimal copy", () => {
  it("has no explanatory paragraphs, no gate tag column and no duplicated headings (CR-563, CR-564)", async () => {
    setup({
      deployments: () =>
        jsonResponse(
          list([
            deployment(1, { status: "QUARANTINED" }),
            deployment(2, { loaded: false }),
          ]),
        ),
      models: () => jsonResponse({ ...catalog(), truncated: true }),
    });
    await open();
    await screen.findByRole("table", { name: "Modelos registrados" });
    for (const sentence of [
      /Se recarga al activar/,
      /Quítalo y vuelve a desplegarlo/,
      /Solo los más recientes\./,
    ])
      expect(screen.queryByText(sentence)).toBeNull();
    expect(
      screen.getByRole("img", { name: "Solo los más recientes" }),
    ).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /Gate/ })).toBeNull();
    // The student-controlled tag is never shown.
    expect(screen.queryByText("passed")).toBeNull();
  });

  it("shows the reasons of a rejected deployment once, not in the result and again in the list (CR-563)", async () => {
    const rejected = deployment(3, {
      status: "FAILED",
      gate: {
        featureSchemaVersion: "invoice-features-v2",
        checkedAt: "2026-11-03T10:00:00.000Z",
        passed: false,
        metrics: null,
        reasons: [{ code: "NO_PREDICT_PROBA", message: "x", detail: {} }],
      },
    });
    // After the POST the list holds the rejected row, as the real API does.
    let rows = [deployment(2)];
    setup({
      post: () => {
        rows = [rejected, deployment(2)];
        return jsonResponse({ deployment: rejected }, 201);
      },
      deployments: () => jsonResponse(list(rows)),
    });
    await open();
    fireEvent.click(await deployButton("3"));
    await screen.findByRole("alert", { name: "Resultado del despliegue" });
    // The refreshed list holds the rejected row too, without repeating it.
    await screen.findByRole("table", { name: "Despliegues del contexto" });
    await waitFor(() =>
      expect(screen.getAllByText(/invoice-risk · versión 3/).length).toBe(1),
    );
    expect(screen.getAllByText(/predict_proba/)).toHaveLength(1);
  });
});

describe("MLOPS-05 failures of the transport", () => {
  it("reads a gateway timeout as «sin respuesta» and refreshes the list (CR-553)", async () => {
    const { transport } = setup({
      post: () =>
        new Response("<html><body>504 Gateway Time-out</body></html>", {
          status: 504,
          headers: { "Content-Type": "text/html" },
        }),
    });
    await open();
    await screen.findByText("1/3 activos");
    const before = transport.calls(`GET ${DEPLOYMENTS}`).length;
    fireEvent.click(await deployButton("3"));
    expect(await screen.findByText("Sin respuesta del servicio.")).toBeTruthy();
    expect(screen.queryByText(/Gateway/)).toBeNull();
    await waitFor(() =>
      expect(transport.calls(`GET ${DEPLOYMENTS}`).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("refreshes the list after a removal that got no answer (CR-553)", async () => {
    const { transport } = setup({
      del: () => new Response("<html>504</html>", { status: 504 }),
    });
    await open();
    await screen.findByText("1/3 activos");
    const before = transport.calls(`GET ${DEPLOYMENTS}`).length;
    fireEvent.click(
      screen.getByRole("button", { name: "Quitar invoice-risk versión 2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmar: quitar" }));
    expect(await screen.findByText("Sin respuesta del servicio.")).toBeTruthy();
    await waitFor(() =>
      expect(transport.calls(`GET ${DEPLOYMENTS}`).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("tells a busy system from an unavailable service (CR-574)", async () => {
    setup({ post: () => errorResponse(503, "RETRYABLE_CONFLICT") });
    await open();
    fireEvent.click(await deployButton("3"));
    expect(
      await screen.findByText("Sistema ocupado. Intenta en unos segundos."),
    ).toBeTruthy();
    expect(screen.queryByText("Servicio de modelos no disponible.")).toBeNull();
  });

  it("reads Cloudflare's 524 like a 504: «sin respuesta» and a refreshed list (CR-582)", async () => {
    const { transport } = setup({
      post: () =>
        new Response("<html><body>Error 524</body></html>", {
          status: 524,
          headers: { "Content-Type": "text/html" },
        }),
    });
    await open();
    await screen.findByText("1/3 activos");
    const before = transport.calls(`GET ${DEPLOYMENTS}`).length;
    fireEvent.click(await deployButton("3"));
    expect(await screen.findByText("Sin respuesta del servicio.")).toBeTruthy();
    expect(screen.queryByText(/524/)).toBeNull();
    await waitFor(() =>
      expect(transport.calls(`GET ${DEPLOYMENTS}`).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("does not blame the scope when the model service has no room (CR-584)", async () => {
    setup({ post: () => errorResponse(409, "DEPLOYMENT_LIMIT") });
    await open();
    await screen.findByText("1/3 activos");
    fireEvent.click(await deployButton("3"));
    expect(await screen.findByText("No hay cupo ahora.")).toBeTruthy();
    expect(screen.queryByText(/Máximo de despliegues/)).toBeNull();
    // The list says there is room in the scope: its button stays usable.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Desplegar invoice-risk versión 3" })
          .getAttribute("aria-disabled"),
      ).toBeNull(),
    );
    expect(screen.queryByText("Máximo alcanzado")).toBeNull();
  });

  it("says the same short thing when the scope's cap is the cause, and the list names the cap once (CR-584)", async () => {
    const state = { full: false };
    const mixed = [deployment(1), deployment(2), deployment(4)];
    setup({
      deployments: () =>
        jsonResponse(list(state.full ? mixed : [deployment(2)])),
      post: () => {
        state.full = true;
        return errorResponse(409, "DEPLOYMENT_LIMIT");
      },
    });
    await open();
    await screen.findByText("1/3 activos");
    fireEvent.click(await deployButton("3"));
    expect(await screen.findByText("No hay cupo ahora.")).toBeTruthy();
    expect(await screen.findByText("Máximo alcanzado")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Desplegar invoice-risk versión 3" })
        .getAttribute("title"),
    ).toBe("Máximo de 3 activos");
  });

  it("shows the wait the server asks for when the checks are limited (CR-574)", async () => {
    setup({
      post: () =>
        new Response(
          JSON.stringify({ error: { code: "RATE_LIMITED", message: "x" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "120",
            },
          },
        ),
    });
    await open();
    fireEvent.click(await deployButton("3"));
    expect(
      await screen.findByText("Demasiadas verificaciones. Espera 2 min."),
    ).toBeTruthy();
  });
});

describe("MLOPS-05 access lost on a read (CR-555)", () => {
  it.each([
    ["models", 404],
    ["models", 403],
    ["deployments", 403],
    ["deployments", 404],
  ])(
    "a %s read answering %s refreshes the profile and the screen becomes «not found» when the section is off",
    async (which, status) => {
      const state = { enabled: true };
      const { transport } = setup({
        profile: () => profile({ enabled: state.enabled }),
        ...(which === "models"
          ? {
              models: () => {
                state.enabled = false;
                return errorResponse(
                  status,
                  status === 404 ? "NOT_FOUND" : "FORBIDDEN",
                );
              },
            }
          : {
              deployments: () => {
                state.enabled = false;
                return errorResponse(
                  status,
                  status === 404 ? "NOT_FOUND" : "FORBIDDEN",
                );
              },
            }),
      });
      await open();
      await screen.findByRole("heading", { name: "Página no encontrada" });
      expect(
        transport.calls("GET /api/v1/auth/profile").length,
      ).toBeGreaterThan(1);
      expect(screen.queryByRole("link", { name: "Modelos" })).toBeNull();
    },
  );

  it("stays on the screen, with a retry, when the profile still says it is on", async () => {
    setup({ models: () => errorResponse(404, "NOT_FOUND") });
    await open();
    expect(
      await screen.findByRole("button", { name: "Reintentar modelos" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Página no encontrada" }),
    ).toBeNull();
  });
});

describe("MLOPS-05 MLflow link (CR-570)", () => {
  it.each([
    ["null", null],
    ["javascript:", "javascript:alert(1)"],
    ["ftp:", "ftp://mlflow.example.test"],
    ["relative", "/mlflow"],
    ["data:", "data:text/html,x"],
  ])("offers no link when the url is %s", async (_name, mlflowUrl) => {
    setup({ models: () => jsonResponse({ ...catalog(), mlflowUrl }) });
    await open();
    await deployButton("3");
    expect(screen.queryByRole("link", { name: /Abrir MLflow/ })).toBeNull();
  });

  it("offers the link for plain http as well as https", async () => {
    setup({
      models: () =>
        jsonResponse({
          ...catalog(),
          mlflowUrl: "http://mlflow.internal:5000/",
        }),
    });
    await open();
    expect(
      (await screen.findByRole("link", { name: /Abrir MLflow/ })).getAttribute(
        "href",
      ),
    ).toBe("http://mlflow.internal:5000/");
  });
});

describe("MLOPS-05 console output", () => {
  it("does not log errors in a normal run (no file-wide silencing)", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    setup();
    await open();
    await deployButton("3");
    expect(logged).not.toHaveBeenCalled();
  });
});
