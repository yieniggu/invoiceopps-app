import type { Page } from "@playwright/test";

import { expect, isMobile, test } from "../support/test.ts";
import { Api } from "../support/api.ts";
import { ALL_FLAGS, createScenario } from "../support/scenario.ts";
import { notice } from "../support/notice.ts";
import {
  GROUP_SELECT,
  ORGANIZATION_SELECT,
  selectGroupScope,
} from "../support/invoices.ts";
import { sidebarNav } from "../support/layout.ts";
import { login, organizations, people, seededIds } from "../support/seeded.ts";

const organizationSelect = (page: Page) =>
  page.getByLabel(ORGANIZATION_SELECT, { exact: true });
const groupSelect = (page: Page) =>
  page.getByLabel(GROUP_SELECT, { exact: true });

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
    await expect(organizationSelect(page)).toContainText(
      organizations.acme.name,
    );
    await expect(groupSelect(page)).toHaveValue(/^group:/);
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
    await expect(organizationSelect(page)).toHaveCount(0);
    await expect(groupSelect(page)).toHaveCount(0);
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
    await expect(organizationSelect(page)).toHaveCount(0);
    await expect(groupSelect(page)).toHaveCount(0);
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

  test("an organization ADMIN without invoice flags reads every invoice of the organization and its groups", async ({
    page,
    app,
  }) => {
    // A private organization: the ADMIN has no flag and belongs to no group,
    // the member creates the invoices.
    const s = await createScenario({
      members: 1,
      groups: 1,
      memberFlags: ALL_FLAGS,
    });
    try {
      const [member] = s.members;
      const [group] = s.groups;
      const creator = await Api.signIn(member.credentials);
      try {
        for (const [index, groupId] of [null, group!.id].entries()) {
          await creator.call(
            "post",
            "/invoices",
            {
              organizationId: s.org.id,
              groupId,
              businessId: groupId ? "ADM-GRUPO" : "ADM-ORG",
              supplierName: "Proveedor administrador",
              amountPesos: 2000 + index,
              currency: "CLP",
              issuedOn: "2026-10-01",
              dueOn: "2026-11-01",
              businessStatus: "PENDING",
            },
            { "Idempotency-Key": `e2e-admin-${s.org.id}-${index}` },
          );
        }
      } finally {
        await creator.dispose();
      }

      await app.openAs(s.admin.credentials, "/invoices");
      // «Todos» is the default: the whole organization, group invoices included.
      await expect(page.getByRole("link", { name: "ADM-ORG" })).toBeVisible();
      await expect(page.getByRole("link", { name: "ADM-GRUPO" })).toBeVisible();
      await expect(organizationSelect(page)).toBeVisible();
      await expect(groupSelect(page)).toBeVisible();
      await app.shot("invoices-admin-organization");

      await selectGroupScope(page, {
        organization: s.org.name,
        group: group!.name,
      });
      await expect(page.getByRole("link", { name: "ADM-GRUPO" })).toBeVisible();
      await expect(page.getByRole("link", { name: "ADM-ORG" })).toHaveCount(0);
      await page.getByRole("link", { name: "ADM-GRUPO" }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "ADM-GRUPO" }),
      ).toBeVisible();
      // Read only: an ADMIN without flags cannot delete.
      await expect(
        page.getByRole("button", { name: "Eliminar factura" }),
      ).toHaveCount(0);
      // Back restores both selects.
      await page.getByRole("link", { name: "Volver a facturas" }).click();
      await expect(organizationSelect(page)).toContainText(s.org.name);
      await expect(groupSelect(page)).toHaveValue(/^group:/);
      await expect(page.getByRole("link", { name: "ADM-GRUPO" })).toBeVisible();
    } finally {
      await s.dispose();
    }
  });

  test("the platform administrator reads the invoices of an organization it does not belong to", async ({
    page,
    app,
  }) => {
    const s = await createScenario({
      members: 1,
      groups: 1,
      memberFlags: ALL_FLAGS,
    });
    try {
      const [member] = s.members;
      const [group] = s.groups;
      const creator = await Api.signIn(member.credentials);
      try {
        await creator.call(
          "post",
          "/invoices",
          {
            organizationId: s.org.id,
            groupId: group!.id,
            businessId: "PLAT-GRUPO",
            supplierName: "Proveedor plataforma",
            amountPesos: 3000,
            currency: "CLP",
            issuedOn: "2026-10-01",
            dueOn: "2026-11-01",
            businessStatus: "PENDING",
          },
          { "Idempotency-Key": `e2e-platform-${s.org.id}` },
        );
      } finally {
        await creator.dispose();
      }

      await app.openAs(login(people.platform), "/invoices");
      await expect(organizationSelect(page)).toBeVisible();
      await selectGroupScope(page, {
        organization: s.org.name,
        group: group!.name,
      });
      await expect(
        page.getByRole("link", { name: "PLAT-GRUPO" }),
      ).toBeVisible();
      await app.shot("invoices-platform-admin");
      await page.getByRole("link", { name: "PLAT-GRUPO" }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "PLAT-GRUPO" }),
      ).toBeVisible();
    } finally {
      await s.dispose();
    }
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
        page.getByRole("heading", { level: 1, name: "Mi perfil" }),
      ).toBeVisible();
      await expect(
        page.locator("header.page-header").getByText(person.name),
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

  test("changes the password from the profile and stays signed in", async ({
    page,
    app,
  }) => {
    // A person of its own: the change revokes every session of that person.
    const s = await createScenario({ members: 1 });
    try {
      const [person] = s.members;
      await app.openAs(person.credentials, "/profile");
      const current = page.getByLabel("Contraseña actual");
      const next = page.getByLabel("Contraseña nueva");
      const submit = page.getByRole("button", { name: "Cambiar contraseña" });

      await current.fill("wrong-password");
      await next.fill(`New-${person.id.slice(0, 8)}-pass`);
      await submit.click();
      await expect(
        page.getByText("La contraseña actual no es correcta."),
      ).toBeVisible();
      await expect(current).toHaveAttribute("aria-invalid", "true");

      await current.fill(person.credentials.password);
      await submit.click();
      await expect(notice(page, "Contraseña actualizada.")).toBeVisible();
      await expect(page).toHaveURL(/\/profile$/);
      await expect(page.getByLabel("Contraseña actual")).toHaveValue("");
      await app.shot("profile-password-changed");

      // The rotated session cookie keeps the person signed in.
      await page.reload();
      await expect(
        page.getByRole("heading", { level: 1, name: "Mi perfil" }),
      ).toBeVisible();
    } finally {
      await s.dispose();
    }
  });

  test("lists the organizations with role and groups", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.carla), "/profile");
    const organizationsList = page.getByRole("region", {
      name: "Organizaciones",
    });
    await expect(
      organizationsList.getByText(organizations.acme.name),
    ).toBeVisible();
    await expect(organizationsList.getByText("Contabilidad")).toBeVisible();
    await app.shot("profile-organizations");
  });

  test("the change-password route is only for forced changes", async ({
    page,
    app,
  }) => {
    await app.openAs(login(people.felipe), "/change-password");
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
