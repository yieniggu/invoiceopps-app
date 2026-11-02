import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, signInApi, test } from "../support/test.ts";
import { Api } from "../support/api.ts";
import { expectSecretAbsent } from "../support/secrets.ts";
import { ALL_FLAGS, createScenario, unique } from "../support/scenario.ts";
import { auditLoopbackOnly } from "../support/network.ts";
import {
  authorizeBearer,
  execute,
  liveBody,
  liveJson,
  liveStatus,
  openOperation,
  operation,
} from "../support/swagger.ts";

// This spec types a bearer secret into Swagger UI. Playwright's failure
// screenshot and trace (DOM snapshots and the network log) are not masked, so
// a failure here would keep that secret in `test-results/`: both are off for
// this file, and the global teardown drops the ARIA snapshot of a failure.
test.use({ screenshot: "off", trace: "off" });

test("Swagger UI authorizes with a bearer token and exercises the invoice API from the browser", async ({
  page,
  context,
}, testInfo) => {
  // A private organization with one member allowed to read and create invoices.
  const s = await createScenario({ members: 1, memberFlags: ALL_FLAGS });
  let member: Api | undefined;
  try {
    const [person] = s.members;
    member = await Api.signIn(person.credentials);
    const token = unique();
    const { token: emitted, secret } = await member.call<{
      token: { id: string };
      secret: string;
    }>("post", "/api-tokens", {
      name: `Swagger ${token}`,
      organizationId: s.org.id,
      scopes: ["invoices:read", "invoices:create"],
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    expect(secret).toMatch(/^iop_/);

    // Fresh browser context: no cookie, and nothing may leave the machine
    // (the UI must not need a CDN, fonts or the online validator).
    expect(await context.cookies()).toEqual([]);
    const blocked = await auditLoopbackOnly(context);

    await page.goto("/docs");
    await expect(page).toHaveURL(/\/docs\/$/);
    await expect(
      page.getByRole("heading", { level: 1, name: /InvoiceOps API/ }),
    ).toBeVisible();
    await expect(
      page.locator(".opblock-tag", { hasText: "Invoices" }),
    ).toBeVisible();

    // Authorize with the bearer scheme only.
    await authorizeBearer(page, secret);

    // POST /api/v1/invoices, organization scope.
    const create = operation(page, "post", "/api/v1/invoices");
    await openOperation(create);
    const businessId = `SWG-${token}`;
    const key = `swagger-${token}-key-0001`;
    const body = JSON.parse(
      await create.locator("textarea.body-param__text").inputValue(),
    );
    // The first documented example is the organization scope (no groupId).
    expect(body).not.toHaveProperty("groupId");
    expect(body.amountPesos).toBe(12500);
    const payload = {
      ...body,
      organizationId: s.org.id,
      businessId,
    };
    await create
      .locator('tr[data-param-name="Idempotency-Key"] input')
      .fill(key);
    const bodyField = create.locator("textarea.body-param__text");
    await bodyField.fill(JSON.stringify(payload, null, 2));

    await execute(create);
    await expect(liveStatus(create)).toHaveText("201");
    const created = await liveJson<{ invoice: { id: string } }>(create);
    const invoiceId = created.invoice.id;
    expect(invoiceId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(create.locator(".live-responses-table")).not.toContainText(
      /idempotency-replayed/i,
    );

    // The row exists, read through the real API as the member.
    const stored = await member.call<{ invoice: { businessId: string } }>(
      "get",
      `/invoices/${invoiceId}?organizationId=${s.org.id}`,
    );
    expect(stored.invoice.businessId).toBe(businessId);

    // Same key and payload: the stored response is replayed.
    await execute(create);
    await expect(liveStatus(create)).toHaveText("201");
    await expect(create.locator(".live-responses-table")).toContainText(
      /idempotency-replayed:\s*true/i,
    );
    expect(
      (await liveJson<{ invoice: { id: string } }>(create)).invoice.id,
    ).toBe(invoiceId);

    // Same key, different payload: conflict.
    await bodyField.fill(
      JSON.stringify({ ...payload, amountPesos: 99000 }, null, 2),
    );
    await execute(create);
    await expect(liveStatus(create)).toHaveText("409");
    await expect(liveBody(create).first()).toContainText(
      "IDEMPOTENCY_CONFLICT",
    );

    // GET list and GET detail.
    const list = operation(page, "get", "/api/v1/invoices");
    await openOperation(list);
    await list
      .locator('tr[data-param-name="organizationId"] input')
      .fill(s.org.id);
    await execute(list);
    await expect(liveStatus(list)).toHaveText("200");
    await expect(liveBody(list).first()).toContainText(invoiceId);

    const detail = operation(page, "get", "/api/v1/invoices/{invoiceId}");
    await openOperation(detail);
    await detail
      .locator('tr[data-param-name="invoiceId"] input')
      .fill(invoiceId);
    await detail
      .locator('tr[data-param-name="organizationId"] input')
      .fill(s.org.id);
    await execute(detail);
    await expect(liveStatus(detail)).toHaveText("200");
    await expect(liveBody(detail).first()).toContainText(businessId);

    // Revoking the token (session) ends the access the UI still holds.
    await member.call("delete", `/api-tokens/${emitted.id}`);
    await execute(detail);
    await expect(liveStatus(detail)).toHaveText("401");

    // Authorization is not persisted: a reload starts logged out.
    await page.reload();
    await page.getByRole("button", { name: "Authorize" }).click();
    const reopened = page.locator(".dialog-ux .modal-ux");
    const fresh = reopened.locator(".auth-container", {
      hasText: "bearerAuth",
    });
    await expect(fresh.locator("input[type=text]")).toHaveValue("");
    await expect(fresh.getByText("Authorized")).toHaveCount(0);
    await expect(fresh.getByRole("button", { name: "Logout" })).toHaveCount(0);
    await reopened.getByRole("button", { name: "Close" }).first().click();
    await expect(
      page.locator(".scheme-container .btn.authorize.unlocked"),
    ).toBeVisible();
    await expectSecretAbsent(page, secret);

    // Screenshot after the reload, so no secret is on the page.
    // Not `app.shot`: its horizontal-overflow guard is for our own screens, and
    // this page is the third-party Swagger UI.
    const directory = resolve(
      import.meta.dirname,
      "../e2e-artifacts",
      testInfo.project.name,
    );
    mkdirSync(directory, { recursive: true });
    await page.screenshot({
      path: resolve(directory, "swagger-docs.png"),
      fullPage: true,
    });

    expect(blocked, "requests to non-loopback hosts").toEqual([]);
  } finally {
    await member?.dispose();
    await s.dispose();
  }
});

test("Swagger UI never sends the app session cookie, even in a logged-in browser", async ({
  page,
  context,
}) => {
  const s = await createScenario({ members: 1, memberFlags: ALL_FLAGS });
  let member: Api | undefined;
  let emittedId: string | undefined;
  try {
    const [person] = s.members;
    member = await Api.signIn(person.credentials);
    const token = unique();
    const { token: emitted, secret } = await member.call<{
      token: { id: string };
      secret: string;
    }>("post", "/api-tokens", {
      name: `Swagger cookie ${token}`,
      organizationId: s.org.id,
      scopes: ["invoices:read", "invoices:create"],
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    emittedId = emitted.id;

    // The browser is signed in to the app: the session cookie is on this origin.
    await signInApi(page, person.credentials);
    expect(
      (await context.cookies()).some((c) => c.name === "invoiceops_session"),
    ).toBe(true);

    await page.goto("/docs/");
    await expect(
      page.getByRole("heading", { level: 1, name: /InvoiceOps API/ }),
    ).toBeVisible();

    // Not authorized yet: the cookie alone would list the invoices (200); from
    // /docs it is not sent, so the answer is 401.
    const list = operation(page, "get", "/api/v1/invoices");
    await openOperation(list);
    await list
      .locator('tr[data-param-name="organizationId"] input')
      .fill(s.org.id);
    await execute(list);
    await expect(liveStatus(list)).toHaveText("401");

    await authorizeBearer(page, secret);

    // Bearer plus the (unsent) cookie: 201, not 400 AMBIGUOUS_AUTH.
    const create = operation(page, "post", "/api/v1/invoices");
    await openOperation(create);
    const body = JSON.parse(
      await create.locator("textarea.body-param__text").inputValue(),
    );
    await create
      .locator('tr[data-param-name="Idempotency-Key"] input')
      .fill(`swagger-${token}-cookie-0001`);
    await create
      .locator("textarea.body-param__text")
      .fill(
        JSON.stringify(
          { ...body, organizationId: s.org.id, businessId: `SWC-${token}` },
          null,
          2,
        ),
      );
    await execute(create);
    await expect(liveStatus(create)).toHaveText("201");
  } finally {
    try {
      // Also when the test failed: the token is valid for 24 hours.
      if (emittedId) await member?.call("delete", `/api-tokens/${emittedId}`);
    } finally {
      await member?.dispose();
      await s.dispose();
    }
  }
});
