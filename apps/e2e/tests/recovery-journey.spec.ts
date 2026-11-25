import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  request,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { expect, signInApi, test } from "../support/test.ts";
import { Api, settlePassword } from "../support/api.ts";
import { BASE_URL } from "../support/env.ts";
import { selectGroupScope } from "../support/invoices.ts";
import { auditLoopbackOnly } from "../support/network.ts";
import { notice } from "../support/notice.ts";
import {
  E2E_PASSWORD,
  NO_FLAGS,
  READ_ONLY,
  asPlatform,
  freshRut,
  people,
  unique,
} from "../support/scenario.ts";
import {
  expectSecretAbsent,
  expectTextWithoutSecret,
} from "../support/secrets.ts";
import { login } from "../support/seeded.ts";
import {
  authorizeBearer,
  execute,
  liveBody,
  liveJson,
  liveStatus,
  openOperation,
  operation,
} from "../support/swagger.ts";

/**
 * RP0-20: the integrated P0 journey. One run, from people created in the Admin
 * panel to a token revoked in React, where every surface acts on the same rows
 * of the real PostgreSQL database: React, Swagger UI in a browser without any
 * cookie, and the classroom curl and Python clients. Each step names the global
 * criteria (G01-G20, see docs/recovery-acceptance.md) it proves. Every browser
 * context aborts and records any request that leaves loopback (G15).
 *
 * Temporary passwords and a bearer secret appear on screen: the failure
 * screenshot and trace are off for this file, and the global teardown drops
 * the ARIA snapshot of a failure (see SECRET_SPECS).
 */
test.use({ screenshot: "off", trace: "off" });

const CLIENTS_DIRECTORY = resolve(
  import.meta.dirname,
  "../../../examples/recovery",
);
const CLIENTS = [
  { name: "curl", script: resolve(CLIENTS_DIRECTORY, "create-invoice.sh") },
  { name: "python", script: resolve(CLIENTS_DIRECTORY, "create-invoice.py") },
] as const;

const h1 = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

interface ClientRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a classroom client with the secret on stdin, never as an argument. */
function runClient(
  script: string,
  args: string[],
  secret: string,
): Promise<ClientRun> {
  return new Promise((done, fail) => {
    const child = spawn(script, args, {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(`${secret}\n`);
  });
}

const createdIdOf = (output: string) =>
  /\[crear\] HTTP 201 id=([0-9a-f-]{36})/.exec(output)?.[1];

/** A cookie session over the real API, with the Origin the backend checks. */
async function sessionOf(credentials: { rut: string; password: string }) {
  const context = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
  });
  const response = await context.post("/api/v1/auth/login", {
    data: credentials,
  });
  expect(response.status(), "session sign-in").toBe(200);
  return context;
}

async function signInThroughForm(page: Page, rut: string, password: string) {
  await page.goto("/");
  await page.getByLabel("RUT", { exact: true }).fill(rut);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

/** Reads the one-time password of the dialog and closes it. */
async function readTemporaryPassword(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Contraseña temporal" });
  await expect(dialog).toBeVisible();
  const value = dialog.locator(".secret-value");
  await expect(value).not.toBeEmpty();
  const temporary = (await value.textContent())?.trim() ?? "";
  expect(temporary.length).toBeGreaterThan(8);
  await dialog.getByRole("button", { name: "Ya copié la contraseña" }).click();
  await expect(dialog).toBeHidden();
  return temporary;
}

async function fillInvoice(page: Page, businessId: string) {
  await page.getByLabel("Número de factura").fill(businessId);
  await page.getByLabel("Proveedor").fill(`Proveedor ${businessId}`);
  await page.getByLabel("Monto en pesos (CLP)").fill("12.500");
  await page.getByLabel("Fecha de emisión").fill("2026-10-25");
  await page.getByLabel("Fecha de vencimiento").fill("2026-11-25");
}

test("RP0-20: the same rows cross the Admin panel, React, Swagger, curl and Python", async ({
  browser,
}, testInfo) => {
  // Four browser contexts, two client runs per client and a dozen screens.
  test.setTimeout(120_000);
  const token = unique();
  const contexts: BrowserContext[] = [];
  const outbound: string[][] = [];
  const sessions: APIRequestContext[] = [];
  const apis: Api[] = [];

  async function freshPage(target: Browser, info: TestInfo) {
    const { colorScheme, viewport } = info.project.use;
    const context = await target.newContext({
      baseURL: BASE_URL,
      locale: "es-CL",
      timezoneId: "America/Santiago",
      colorScheme,
      viewport,
    });
    contexts.push(context);
    outbound.push(await auditLoopbackOnly(context));
    return context.newPage();
  }

  try {
    // ── G16, G03: the platform creates two people without organization ──
    const platform = await freshPage(browser, testInfo);
    await signInApi(platform, login(people.platform));
    const ana = { name: `Ana ${token}`, rut: freshRut() };
    const bruno = { name: `Bruno ${token}`, rut: freshRut() };
    const createWithoutOrganization = async (person: typeof ana) => {
      await platform.goto("/admin/users/new");
      await platform.getByLabel("Nombre completo").fill(person.name);
      await platform.getByLabel("RUT del usuario").fill(person.rut.api);
      for (const step of [2, 3, 4]) {
        await platform.getByRole("button", { name: "Siguiente" }).click();
        await expect(
          platform.getByRole("heading", {
            name: new RegExp(`Paso ${step} de 4`),
          }),
        ).toBeVisible();
      }
      await platform.getByRole("button", { name: "Crear usuario" }).click();
      return readTemporaryPassword(platform);
    };
    const anaTemporary = await createWithoutOrganization(ana);
    const brunoTemporary = await createWithoutOrganization(bruno);
    await expectSecretAbsent(platform, anaTemporary);
    await expectSecretAbsent(platform, brunoTemporary);

    // ── G03, G20: the organization (a course) with Ana as its first ADMIN ──
    const organizationName = `Curso ${token}`;
    await platform.goto("/organizations/new");
    await platform
      .getByLabel("Nombre de la organización")
      .fill(organizationName);
    await platform.getByLabel(/Identificador/).fill(`curso-${token}`);
    await platform.getByLabel("RUT del primer administrador").fill(ana.rut.api);
    await platform.getByRole("button", { name: "Crear organización" }).click();
    await expect(platform.locator(".toast")).toContainText(
      `Organización «${organizationName}» creada.`,
    );

    await settlePassword({ rut: ana.rut.api, temporaryPassword: anaTemporary });
    const anaCredentials = { rut: ana.rut.api, password: E2E_PASSWORD };
    const anaApi = await Api.signIn(anaCredentials);
    apis.push(anaApi);
    const { organizations } = await anaApi.call<{
      organizations: Array<{ id: string; slug: string }>;
    }>("get", "/organizations");
    const organization = organizations.find(
      ({ slug }) => slug === `curso-${token}`,
    );
    expect(organization, "Ana administers the new course").toBeDefined();
    const orgId = organization!.id;

    // ── G03: Ana creates a group (a team) in the UI ──
    const admin = await freshPage(browser, testInfo);
    await signInApi(admin, anaCredentials);
    const groupName = `Equipo ${token}`;
    await admin.goto(`/organizations/${orgId}/groups`);
    await admin.getByRole("link", { name: "Crear grupo" }).click();
    await admin.getByLabel("Nombre del grupo").fill(groupName);
    await admin.getByLabel(/Descripción/).fill("Equipo del recorrido RP0-20");
    await admin.getByRole("button", { name: "Crear grupo" }).click();
    await expect(h1(admin, "Agregar miembros al grupo")).toBeVisible();
    const { groups } = await anaApi.call<{
      groups: Array<{ id: string; name: string }>;
    }>("get", `/organizations/${orgId}/groups`);
    const groupId = groups.find(({ name }) => name === groupName)?.id;
    expect(groupId, "the group Ana created").toBeDefined();

    // ── G03, G17: Bruno joins by RUT; per-user flags in org and group ──
    // Organization: create only (no read). Group: read, create, delete own.
    await admin.goto(`/organizations/${orgId}/members/new`);
    await admin.getByLabel("RUT de la persona").fill(bruno.rut.api);
    await admin.getByRole("button", { name: "Agregar persona" }).click();
    await expect(
      notice(admin, "Persona agregada a la organización."),
    ).toBeVisible();
    await admin.getByRole("link", { name: bruno.name }).click();
    await expect(h1(admin, bruno.name)).toBeVisible();
    const brunoId = new URL(admin.url()).pathname.split("/").pop()!;
    const saveBruno = admin.getByRole("button", {
      name: `Guardar permisos de ${bruno.name}`,
    });
    // The group editor is folded, so these are the organization toggles.
    const orgCreate = admin.getByRole("button", { name: "Crear facturas" });
    await orgCreate.click();
    await expect(orgCreate).toHaveAttribute("aria-pressed", "true");
    await saveBruno.click();
    await expect(admin.getByText("Permisos guardados")).toBeVisible();
    const addToGroup = admin.locator(
      'form[aria-labelledby="add-to-group-title"]',
    );
    await addToGroup.getByLabel("Grupo").selectOption({ label: groupName });
    await addToGroup.getByRole("button", { name: /Ver permisos/ }).click();
    for (const flag of [
      "Leer facturas",
      "Crear facturas",
      "Eliminar facturas propias",
    ]) {
      const toggle = addToGroup.getByRole("button", { name: flag });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
    }
    await addToGroup.getByRole("button", { name: "Agregar al grupo" }).click();
    // The form no longer announces a success text: with the only group taken
    // it says there is none left to add. The flags are proven later, when
    // Bruno reads and creates in the group.
    await expect(
      addToGroup.getByText(
        "No hay más grupos en esta organización para agregar a la persona.",
      ),
    ).toBeVisible();
    // Bruno is now listed among the member's groups (a folded card titled
    // with the group name).
    await expect(
      admin
        .locator('section[aria-labelledby="member-groups-title"]')
        .getByRole("button", { name: new RegExp(groupName) }),
    ).toBeVisible();

    // Carla, a second member of the same group with other flags (read only).
    const carla = { name: `Carla ${token}`, rut: freshRut() };
    const platformApi = await asPlatform();
    apis.push(platformApi);
    const carlaTemporary = `Tmp-${token}-carla`;
    await platformApi.call("post", "/admin/users", {
      name: carla.name,
      rut: carla.rut.api,
      temporaryPassword: carlaTemporary,
      memberships: [
        {
          organizationId: orgId,
          role: "USER",
          permissions: NO_FLAGS,
          groups: [{ groupId, permissions: READ_ONLY }],
        },
      ],
    });
    await settlePassword({
      rut: carla.rut.api,
      temporaryPassword: carlaTemporary,
    });

    // ── G04, G02: Bruno's first sign-in forces a different password ──
    const member = await freshPage(browser, testInfo);
    await signInThroughForm(member, bruno.rut.api, brunoTemporary);
    await expect(h1(member, "Cambia tu contraseña temporal")).toBeVisible();
    await member
      .getByLabel("Contraseña temporal", { exact: true })
      .fill(brunoTemporary);
    const newPassword = member.getByLabel("Contraseña nueva", { exact: true });
    await newPassword.fill(brunoTemporary);
    await member.getByRole("button", { name: "Cambiar contraseña" }).click();
    await expect(
      member.getByText("La nueva contraseña debe ser distinta de la actual."),
    ).toBeVisible();
    await newPassword.fill(E2E_PASSWORD);
    await member.getByRole("button", { name: "Cambiar contraseña" }).click();
    await expect(h1(member, "Panel principal")).toBeVisible();
    await expectSecretAbsent(member, brunoTemporary);
    const brunoCredentials = { rut: bruno.rut.api, password: E2E_PASSWORD };

    // ── G06, G18: Bruno creates in the organization and in the group ──
    // The organization scope is the default of a fresh form; «Crear otra»
    // keeps the scope chosen last, so the group invoice goes second.
    const groupInvoice = `GRP-${token}`;
    const organizationInvoice = `ORG-${token}`;
    const scopeSelect = member.getByLabel("Grupo", { exact: true });
    await member.goto("/invoices/new");
    await fillInvoice(member, organizationInvoice);
    await expect(scopeSelect.locator("option:checked")).not.toHaveText(
      groupName,
    );
    await member.getByRole("button", { name: "Crear factura" }).click();
    await expect(
      member.getByRole("heading", { name: "Factura creada" }),
    ).toBeVisible();
    await member.getByRole("button", { name: "Crear otra" }).click();
    await fillInvoice(member, groupInvoice);
    await scopeSelect.selectOption({ label: groupName });
    await member.getByRole("button", { name: "Crear factura" }).click();
    await expect(
      member.getByRole("heading", { name: "Factura creada" }),
    ).toBeVisible();

    // ── G12, G17: group read shows the group's invoices, not the org's ──
    await member.goto("/invoices");
    await selectGroupScope(member, {
      organization: organizationName,
      group: groupName,
    });
    await expect(
      member.getByRole("link", { name: groupInvoice }),
    ).toBeVisible();
    await expect(
      member.getByRole("link", { name: organizationInvoice }),
    ).toHaveCount(0);

    // ── G07: Bruno emits a token in React; the secret is shown once ──
    await member.goto("/api-tokens");
    await member.getByRole("button", { name: "Emitir token" }).click();
    const form = member.getByRole("dialog", { name: "Emitir token" });
    const tokenName = `Recorrido ${token}`;
    // A token carries the flags its scope grants: in the whole organization
    // Bruno may only create, in the group he may also read.
    await form
      .getByLabel("Alcance del token")
      .selectOption({ label: groupName });
    await form.getByLabel("Nombre del token").fill(tokenName);
    await form.getByRole("checkbox", { name: "Leer facturas" }).check();
    await form.getByRole("checkbox", { name: "Crear facturas" }).check();
    await form.getByRole("button", { name: "Emitir token" }).click();
    const secretDialog = member.getByRole("dialog", { name: "Token emitido" });
    const secret = await secretDialog
      .getByLabel("Token de acceso")
      .inputValue();
    expect(secret).toMatch(/^iop_/);
    await secretDialog
      .getByRole("button", { name: "Ya guardé el token" })
      .click();
    await expect(secretDialog).toBeHidden();
    await member.reload();
    await expect(member.getByText(tokenName, { exact: true })).toBeVisible();
    await expectSecretAbsent(member, secret);

    // ── G08, G09: Swagger UI without any cookie, bearer only ──
    const docs = await freshPage(browser, testInfo);
    expect(await docs.context().cookies()).toEqual([]);
    await docs.goto("/docs");
    await expect(
      docs.getByRole("heading", { level: 1, name: /InvoiceOps API/ }),
    ).toBeVisible();
    await authorizeBearer(docs, secret);
    const create = operation(docs, "post", "/api/v1/invoices");
    await openOperation(create);
    const swaggerInvoice = `SWG-${token}`;
    const example = JSON.parse(
      await create.locator("textarea.body-param__text").inputValue(),
    );
    await create
      .locator('tr[data-param-name="Idempotency-Key"] input')
      .fill(`journey-${token}-swagger-0001`);
    await create.locator("textarea.body-param__text").fill(
      JSON.stringify(
        {
          ...example,
          organizationId: orgId,
          groupId,
          businessId: swaggerInvoice,
        },
        null,
        2,
      ),
    );
    await execute(create);
    await expect(liveStatus(create)).toHaveText("201");
    const swaggerId = (await liveJson<{ invoice: { id: string } }>(create))
      .invoice.id;

    // ── G10: Swagger reads it, and React (refreshed) shows the same row ──
    const detail = operation(docs, "get", "/api/v1/invoices/{invoiceId}");
    await openOperation(detail);
    await detail
      .locator('tr[data-param-name="invoiceId"] input')
      .fill(swaggerId);
    await detail
      .locator('tr[data-param-name="organizationId"] input')
      .fill(orgId);
    await detail.locator('tr[data-param-name="groupId"] input').fill(groupId!);
    await execute(detail);
    await expect(liveStatus(detail)).toHaveText("200");
    await expect(liveBody(detail).first()).toContainText(swaggerInvoice);

    // ── G11, G15: curl and Python create with an idempotency key ──
    const clientInvoices: string[] = [];
    for (const client of CLIENTS) {
      const businessId = `${client.name.toUpperCase()}-${token}`;
      const run = await runClient(
        client.script,
        [
          "create",
          "--base-url",
          BASE_URL,
          "--organization-id",
          orgId,
          "--group-id",
          groupId!,
          "--business-id",
          businessId,
          "--idempotency-key",
          `journey-${token}-${client.name}-0001`,
        ],
        secret,
      );
      expect(run.stderr, `${client.name} stderr`).toBe("");
      expect(run.status, `${client.name} exit`).toBe(0);
      expect(createdIdOf(run.stdout), `${client.name} created`).toBeDefined();
      expect(run.stdout).toContain("replay=true");
      expectTextWithoutSecret(run.stdout, secret, `${client.name} output`);
      clientInvoices.push(businessId);
    }

    await member.goto("/invoices");
    await selectGroupScope(member, {
      organization: organizationName,
      group: groupName,
    });
    for (const businessId of [swaggerInvoice, ...clientInvoices])
      await expect(member.getByRole("link", { name: businessId })).toHaveCount(
        1,
      );

    // ── G12: deletion follows the author; Carla (read only) cannot ──
    const carlaSession = await sessionOf({
      rut: carla.rut.api,
      password: E2E_PASSWORD,
    });
    sessions.push(carlaSession);
    const scope = `organizationId=${orgId}&groupId=${groupId}`;
    expect(
      (
        await carlaSession.delete(`/api/v1/invoices/${swaggerId}?${scope}`)
      ).status(),
      "a reader cannot delete",
    ).toBe(403);
    await member.getByRole("link", { name: clientInvoices[0] }).click();
    await expect(h1(member, clientInvoices[0])).toBeVisible();
    await member.getByRole("button", { name: "Eliminar factura" }).click();
    await member
      .getByRole("dialog")
      .getByRole("button", { name: "Eliminar factura" })
      .click();
    await expect(notice(member, "Factura eliminada.")).toBeVisible();
    await expect(
      member.getByRole("link", { name: clientInvoices[0] }),
    ).toHaveCount(0);

    // ── G17: a flag changed in the UI applies to Bruno's next requests ──
    const brunoSession = await sessionOf(brunoCredentials);
    sessions.push(brunoSession);
    const bearer = await request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
    });
    sessions.push(bearer);
    const groupList = `/api/v1/invoices?${scope}`;
    expect((await brunoSession.get(groupList)).status()).toBe(200);
    expect((await bearer.get(groupList)).status()).toBe(200);

    await admin.goto(
      `/organizations/${orgId}/groups/${groupId}/members/${brunoId}`,
    );
    await expect(h1(admin, bruno.name)).toBeVisible();
    const groupRead = admin.getByRole("button", { name: "Leer facturas" });
    await expect(groupRead).toHaveAttribute("aria-pressed", "true");
    await groupRead.click();
    await saveBruno.click();
    await expect(admin.getByText("Permisos guardados")).toBeVisible();

    expect((await brunoSession.get(groupList)).status(), "session").toBe(403);
    expect((await bearer.get(groupList)).status(), "bearer").toBe(403);
    // Carla's own flag is untouched. Ana (ADMIN, no invoice flags) reads every
    // invoice of her organization (CR-009) but gets no write permission.
    const carlaList = await carlaSession.get(groupList);
    expect(carlaList.status()).toBe(200);
    expect(await carlaList.text()).toContain(swaggerInvoice);
    const anaSession = await sessionOf(anaCredentials);
    sessions.push(anaSession);
    const anaList = await anaSession.get(
      `/api/v1/invoices?organizationId=${orgId}`,
    );
    expect(anaList.status(), "the ADMIN role reads the organization").toBe(200);
    expect(await anaList.text()).toContain(swaggerInvoice);
    expect(
      (
        await anaSession.delete(`/api/v1/invoices/${swaggerId}?${scope}`)
      ).status(),
      "the ADMIN role grants no delete",
    ).toBe(404);

    // ── G14: revoking in React stops Swagger and both clients at once ──
    await member.goto("/api-tokens");
    const row = member.locator("tr", { hasText: tokenName });
    await row
      .getByRole("button", { name: `Revocar token ${tokenName}` })
      .click();
    const confirm = member.getByRole("dialog", { name: "Revocar token" });
    await confirm.getByRole("button", { name: "Revocar token" }).click();
    await expect(row.getByText("Revocado")).toBeVisible();

    await execute(detail);
    await expect(liveStatus(detail)).toHaveText("401");
    for (const client of CLIENTS) {
      const denied = await runClient(
        client.script,
        [
          "get",
          "--base-url",
          BASE_URL,
          "--organization-id",
          orgId,
          "--group-id",
          groupId!,
          "--invoice-id",
          swaggerId,
        ],
        secret,
      );
      expect(denied.status, `${client.name} exit`).toBe(1);
      expect(denied.stderr).toContain("401 no autenticado");
      expectTextWithoutSecret(
        `${denied.stdout}${denied.stderr}`,
        secret,
        `${client.name} denied output`,
      );
    }
    // Bruno's own session is still open: revocation is about the token.
    expect((await brunoSession.get("/api/v1/organizations")).status()).toBe(
      200,
    );

    // ── G15: nothing left the machine, and no page keeps a secret ──
    await docs.reload();
    await expectSecretAbsent(docs, secret);
    await expectSecretAbsent(member, secret);
    for (const requests of outbound)
      expect(requests, "requests to non-loopback hosts").toEqual([]);
  } finally {
    for (const api of apis) await api.dispose();
    for (const session of sessions) await session.dispose();
    for (const context of contexts) await context.close();
  }
});
