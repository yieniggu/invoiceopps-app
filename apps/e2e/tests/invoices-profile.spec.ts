import { expect, isMobile, test } from "../support/test.ts";
import { Api } from "../support/api.ts";
import { ALL_FLAGS, createScenario } from "../support/scenario.ts";
import { notice } from "../support/notice.ts";
import { selectGroupScope } from "../support/invoices.ts";
import { sidebarNav } from "../support/layout.ts";
import { login, organizations, people, seededIds } from "../support/seeded.ts";

const SCOPE = "Ver facturas de";

test.describe("invoices", () => {
  test("lists, searches and opens the detail of a group's invoices", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.carla), "/invoices");
    await selectGroupScope(page, {
      organization: organizations.acme.name,
      group: "Contabilidad",
    });
    for (const businessId of ["FAC-1001", "FAC-1002", "FAC-1003"]) {
      await expect(page.getByRole("link", { name: businessId })).toBeVisible();
    }
    // The group name column names where each invoice lives.
    await expect(
      page.getByRole("columnheader", { name: "Grupo" }),
    ).toBeVisible();
    await expect(
      page.getByRole("row", { name: /FAC-1001/ }).getByText("Contabilidad"),
    ).toBeVisible();
    await app.shot("invoices-list");

    await page.getByLabel("Buscar por número o proveedor").fill("Pacífico");
    await page.getByLabel("Buscar por número o proveedor").press("Enter");
    await expect(page.getByRole("link", { name: "FAC-1002" })).toBeVisible();
    await expect(page.getByRole("link", { name: "FAC-1001" })).toHaveCount(0);

    await page.getByRole("link", { name: "FAC-1002" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "FAC-1002" }),
    ).toBeVisible();
    await expect(
      page.getByText("Servicios Pacífico Ltda").first(),
    ).toBeVisible();
    await app.shot("invoice-detail");
    // Back to the inbox with the scope and the search it came from.
    await page.getByRole("link", { name: "Volver a facturas" }).click();
    await expect(page.getByLabel("Buscar por número o proveedor")).toHaveValue(
      "Pacífico",
    );
    await expect(page.getByLabel(SCOPE)).toHaveValue(/^group:/);
  });

  test("a member without invoice read access sees the empty state", async ({
    page,
    app,
  }) => {
    // Elena belongs to Acme with no invoice flag and to none of its groups.
    await app.openAs(login(people.elena), "/invoices");
    await expect(
      page.getByRole("heading", { level: 1, name: "Facturas" }),
    ).toBeVisible();
    await expect(page.getByText("Aún no puedes ver facturas")).toBeVisible();
    await expect(page.getByLabel(SCOPE)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^FAC-/ })).toHaveCount(0);
    await app.shot("invoices-member-without-read");
  });

  test("a member without any invoice flag has no «Facturas» entry and the route says why", async ({
    page,
    app,
  }, testInfo) => {
    await app.openAs(login(people.elena), "/dashboard");
    await expect(
      page.getByRole("heading", { level: 1, name: "Panel principal" }),
    ).toBeVisible();
    // On mobile the navigation lives behind the menu button.
    if (isMobile(testInfo.project.name)) {
      await page.getByRole("button", { name: "Abrir menú" }).click();
    }
    await expect(
      sidebarNav(page).getByRole("link", { name: "Organizaciones" }),
    ).toBeVisible();
    await expect(
      sidebarNav(page).getByRole("link", { name: "Facturas", exact: true }),
    ).toHaveCount(0);
    // The dashboard offers no invoices card either.
    await expect(page.getByRole("link", { name: "Ir a facturas" })).toHaveCount(
      0,
    );
    await page.goto("/invoices");
    await expect(page.getByText("Aún no puedes ver facturas")).toBeVisible();
    await expect(page.getByLabel(SCOPE)).toHaveCount(0);
  });

  test("a direct link to an invoice that does not exist says so", async ({
    page,
    app,
  }) => {
    const { acme } = await seededIds();
    await app.openAs(
      login(people.carla),
      `/invoices/00000000-0000-4000-8000-00000000dead?organizationId=${acme.id}`,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Factura no encontrada" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Volver a facturas" }),
    ).toBeVisible();
  });

  test("a person who belongs to no organization is told so", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.loner), "/invoices");
    await expect(page.getByText("Aún no puedes ver facturas")).toBeVisible();
    await app.shot("invoices-no-organization");
  });

  test("deletes an invoice after confirming and it is gone after a reload", async ({
    page,
    app,
  }) => {
    // A private organization: the seeded invoices must stay untouched.
    const s = await createScenario({ members: 1, memberFlags: ALL_FLAGS });
    try {
      const [member] = s.members;
      const creator = await Api.signIn(member.credentials);
      try {
        for (const [index, businessId] of ["ELIM-1", "QUEDA-2"].entries()) {
          await creator.call(
            "post",
            "/invoices",
            {
              organizationId: s.org.id,
              groupId: null,
              businessId,
              supplierName: `Proveedor ${businessId}`,
              amountPesos: 10000 + index,
              currency: "CLP",
              issuedOn: "2026-10-01",
              dueOn: "2026-11-01",
              businessStatus: "PENDING",
            },
            { "Idempotency-Key": `e2e-${s.org.id}-${index}` },
          );
        }
      } finally {
        await creator.dispose();
      }

      await app.openAs(member.credentials, "/invoices");
      await expect(page.getByRole("link", { name: "ELIM-1" })).toBeVisible();
      await page.getByRole("link", { name: "ELIM-1" }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "ELIM-1" }),
      ).toBeVisible();

      // The deleted row must never be painted again, not even for a frame
      // from the cache: record every anchor of a table that names it.
      await page.evaluate(() => {
        const seen = { deletedRowPainted: false };
        (window as unknown as { __seen: typeof seen }).__seen = seen;
        new MutationObserver(() => {
          if (
            [...document.querySelectorAll("table a")].some(
              (anchor) => anchor.textContent === "ELIM-1",
            )
          )
            seen.deletedRowPainted = true;
        }).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      await page.getByRole("button", { name: "Eliminar factura" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("ELIM-1");
      await expect(dialog).toContainText("Proveedor ELIM-1");
      await app.shot("invoice-delete-confirm");
      const listAfterDelete = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          /\/api\/v1\/invoices\?/.test(response.url()),
      );
      await dialog.getByRole("button", { name: "Eliminar factura" }).click();

      await expect(page).toHaveURL(/\/invoices\?/);
      await expect(notice(page, "Factura eliminada.")).toBeVisible();
      await expect(page.getByRole("link", { name: "QUEDA-2" })).toBeVisible();
      // The list that arrived does not hold it, and it was never on screen.
      const { items } = (await (await listAfterDelete).json()) as {
        items: Array<{ businessId: string }>;
      };
      expect(items.map(({ businessId }) => businessId)).not.toContain("ELIM-1");
      expect(await page.getByRole("link", { name: "ELIM-1" }).count()).toBe(0);
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                __seen: { deletedRowPainted: boolean };
              }
            ).__seen.deletedRowPainted,
        ),
      ).toBe(false);

      await page.reload();
      await expect(page.getByRole("link", { name: "QUEDA-2" })).toBeVisible();
      await expect(page.getByRole("link", { name: "ELIM-1" })).toHaveCount(0);
      await app.shot("invoice-deleted");
    } finally {
      await s.dispose();
    }
  });
});

test.describe("profile", () => {
  test("shows the identity and saves contact data", async ({ page, app }) => {
    // A person of its own: saving contact data must not touch a seeded fixture.
    const s = await createScenario({ members: 1 });
    try {
      const [person] = s.members;
      await app.openAs(person.credentials, "/profile");
      await expect(
        page.getByRole("heading", { level: 2, name: "Identidad" }),
      ).toBeVisible();
      // Email and username are unique among users: one pair per person.
      const email = `persona.${person.id}@example.com`;
      await page.getByLabel("Correo electrónico").fill(email);
      await page
        .getByLabel("Nombre de usuario")
        .fill(`persona-${person.id.slice(0, 8)}`);
      await page.getByRole("button", { name: "Guardar cambios" }).click();
      await expect(page.getByText("Perfil actualizado.")).toBeVisible();
      await page.reload();
      await expect(page.getByLabel("Correo electrónico")).toHaveValue(email);
      await app.shot("profile-saved");
    } finally {
      await s.dispose();
    }
  });

  test("the change-password route is only for forced changes", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.felipe), "/change-password");
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
