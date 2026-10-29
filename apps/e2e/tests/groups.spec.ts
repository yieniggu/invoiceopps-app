import { expect, test } from "../support/test.ts";
import { expectNoStateWordsInToggles } from "../support/layout.ts";
import { createScenario } from "../support/scenario.ts";
import { notice } from "../support/notice.ts";

const h1 = (page: import("@playwright/test").Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

test.describe("groups", () => {
  test("creates a group and adds several members atomically with shared permissions", async ({
    page,
    app,
  }) => {
    const s = await createScenario({ members: 3 });
    try {
      const [a, b, c] = s.members;
      await app.openAs(
        s.admin.credentials,
        `/organizations/${s.org.id}/groups`,
      );
      await expect(h1(page, "Grupos de la organización")).toBeVisible();
      await page.getByRole("link", { name: "Crear grupo" }).click();
      await expect(h1(page, "Crear grupo")).toBeVisible();
      await page.getByLabel("Nombre del grupo").fill("Equipo Alfa");
      await page.getByLabel(/Descripción/).fill("Grupo creado por la prueba");
      await page.getByRole("button", { name: "Crear grupo" }).click();
      await expect(
        notice(page, "Grupo creado. Agrega a sus miembros."),
      ).toBeVisible();

      // The creation lands on the next step: add members.
      await expect(h1(page, "Agregar miembros al grupo")).toBeVisible();
      // The search runs on the server when it is submitted (Enter / «Buscar»).
      // Each search waits for its own URL, so the next fill never races the
      // navigation of the previous one.
      const search = async (text: string) => {
        await page.getByLabel("Buscar por nombre o RUT").fill(text);
        await page.getByRole("button", { name: "Buscar" }).click();
        await expect(page).toHaveURL(
          text
            ? new RegExp(`[?&]search=${encodeURIComponent(text)}(&|$)`)
            : (url) => !url.searchParams.has("search"),
        );
      };
      // Before searching everybody is listed.
      await expect(page.getByText(a.name)).toBeVisible();
      await expect(page.getByText(b.name)).toBeVisible();
      await expect(page.getByText(c.name)).toBeVisible();
      await search(a.key);
      await expect(page.getByText(a.name)).toBeVisible();
      // Only true once the server filtered: the other members are gone.
      await expect(page.getByText(b.name)).toHaveCount(0);
      await expect(page.getByText(c.name)).toHaveCount(0);
      await search("zzzz-no-match");
      await expect(
        page.getByText("Ninguna persona coincide con la búsqueda."),
      ).toBeVisible();
      await search("");
      await expect(page.getByText(b.name)).toBeVisible();
      await expect(page.getByText(c.name)).toBeVisible();

      // "Select all" applies to the page on screen: the 4 people fit one page.
      await page
        .getByRole("checkbox", { name: "Seleccionar todos en esta página" })
        .check();
      await expect(page.getByText("4 personas seleccionadas.")).toBeVisible();
      await page
        .getByRole("checkbox", { name: new RegExp(s.admin.name) })
        .uncheck();
      await expect(page.getByText("3 personas seleccionadas.")).toBeVisible();

      const shared = page.getByRole("heading", {
        name: "Aplicar los mismos permisos a todos",
      });
      await expect(shared).toBeVisible();
      // Only the shared editor is open: the cards of the people are folded.
      await page.getByRole("button", { name: "Leer facturas" }).click();
      await page
        .getByRole("button", { name: "Aplicar a todos los seleccionados" })
        .click();
      // Every selected card now summarizes the shared flag.
      await expect(page.getByText("1 de 4 permisos")).toHaveCount(3);
      await app.shot("group-add-members-selected");

      // One member's card opens and edits its own flags.
      await page.getByRole("button", { name: b.name, exact: true }).click();
      await expectNoStateWordsInToggles(page);
      await app.shot("group-add-members-card-open");

      await page
        .getByRole("button", { name: "Agregar 3 personas al grupo" })
        .click();
      await expect(h1(page, "Miembros del grupo")).toBeVisible();
      for (const person of [a, b, c]) {
        await expect(
          page.getByRole("link", { name: person.name }),
        ).toBeVisible();
      }
      await expect(page.getByRole("link", { name: s.admin.name })).toHaveCount(
        0,
      );
    } finally {
      await s.dispose();
    }
  });

  test("group summary, members, member page and bulk permissions", async ({
    page,
    app,
  }, testInfo) => {
    const s = await createScenario({ members: 3, groups: 1 });
    try {
      const group = s.groups[0];
      const [a, b] = s.members;
      await s.api.call(
        "post",
        `/organizations/${s.org.id}/groups/${group.id}/memberships/bulk`,
        {
          members: s.members.map((member) => ({
            userId: member.id,
            permissions: {
              readInvoices: true,
              createInvoices: false,
              deleteOwnInvoices: false,
              deleteOthersInvoices: false,
            },
          })),
        },
      );
      const base = `/organizations/${s.org.id}/groups/${group.id}`;

      await app.openAs(s.admin.credentials, base);
      await expect(h1(page, group.name)).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: "Resumen" }),
      ).toBeVisible();
      // The Miembros action sits in the header, next to the title.
      const action = page.getByRole("link", { name: "Miembros", exact: true });
      const title = (await h1(page, group.name).boundingBox())!;
      const actionBox = (await action.boundingBox())!;
      // Beside the title on wide screens; wrapped under it on phones.
      if (testInfo.project.name === "mobile") {
        expect(actionBox.y).toBeGreaterThanOrEqual(title.y);
      } else {
        expect(actionBox.y).toBeLessThan(title.y + title.height);
      }
      await expect(
        page.getByRole("term").filter({ hasText: "Miembros" }),
      ).toBeVisible();
      await app.shot("group-summary");

      await action.click();
      await expect(h1(page, "Miembros del grupo")).toBeVisible();
      await page
        .getByRole("checkbox", { name: `Seleccionar a ${a.name}` })
        .check();
      await page
        .getByRole("checkbox", { name: `Seleccionar a ${b.name}` })
        .check();
      await page
        .getByRole("button", { name: "Editar permisos en bloque" })
        .click();
      await expect(page).toHaveURL(/userIds=/);
      await page.reload();
      await expect(page.locator(".chip-list li")).toHaveCount(2);
      await page.getByRole("button", { name: "Crear facturas" }).click();
      await page.getByRole("button", { name: /^Aplicar a 2/ }).click();
      await expect(h1(page, "Miembros del grupo")).toBeVisible();
      await expect(
        page.getByRole("row", { name: new RegExp(a.name) }),
      ).toContainText("2 de 4 permisos");

      await page.getByRole("link", { name: a.name }).click();
      await expect(h1(page, a.name)).toBeVisible();
      await expectNoStateWordsInToggles(page);
      await page
        .getByRole("button", { name: "Eliminar facturas propias" })
        .click();
      await page
        .getByRole("button", { name: `Guardar permisos de ${a.name}` })
        .click();
      await expect(page.getByText("Permisos guardados")).toBeVisible();
      await page
        .getByRole("button", { name: `Quitar a ${a.name} del grupo` })
        .click();
      await page
        .getByRole("button", { name: `Confirmar quitar a ${a.name}` })
        .click();
      await expect(
        notice(page, `Se quitó a ${a.name} del grupo.`),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: a.name })).toHaveCount(0);
    } finally {
      await s.dispose();
    }
  });

  test("my groups lists the person's groups by organization", async ({
    page,
    app,
  }) => {
    const s = await createScenario({ members: 1, groups: 1 });
    try {
      await app.openAs(s.admin.credentials, "/groups");
      await expect(h1(page, "Grupos")).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: s.org.name }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: `Crear grupo en ${s.org.name}` }),
      ).toBeVisible();
      await app.shot("my-groups-admin");
    } finally {
      await s.dispose();
    }
  });
});
