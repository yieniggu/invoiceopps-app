import {
  expect,
  expectNoHorizontalOverflow,
  expectSettled,
  test,
} from "../support/test.ts";
import { expectNoStateWordsInToggles } from "../support/layout.ts";
import {
  asPlatform,
  createScenario,
  freshRut,
  people,
  unique,
} from "../support/scenario.ts";
import { login, seededIds } from "../support/seeded.ts";
import { notice } from "../support/notice.ts";

const h1 = (page: import("@playwright/test").Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

test.describe("organizations", () => {
  test("the platform administrator creates an organization and finds it in the platform list", async ({
    page,
    app,
  }) => {
    const token = unique();
    // The first administrator is a fresh person: the seeded fixtures are only
    // ever read, and the platform administrator names somebody else.
    const platform = await asPlatform();
    const rut = freshRut();
    await platform.call("post", "/admin/users", {
      name: `Primera Admin ${token}`,
      rut: rut.api,
      memberships: [],
      temporaryPassword: `Tmp-${token}-first`,
    });
    await platform.dispose();

    await app.openAs(login(people.platform), "/organizations/new");
    await page.getByLabel("Nombre de la organización").fill(`Nueva ${token}`);
    await page.getByLabel(/Identificador/).fill(`nueva-${token}`);
    await page.getByLabel("RUT del primer administrador").fill(rut.api);
    await page.getByRole("button", { name: "Crear organización" }).click();

    await expect(h1(page, "Organizaciones")).toBeVisible();
    // The platform administrator is not a member of what they create, but the
    // platform lists and opens every organization (B3c): the notice says so
    // and the card is there.
    const created = page.locator(".toast");
    await expect(created).toContainText(
      `Organización «Nueva ${token}» creada.`,
    );
    // The same text reaches screen readers through the shell's live region.
    await expect(page.locator("[data-notice-region]")).toContainText(
      `Organización «Nueva ${token}» creada.`,
    );
    await expect(created).toContainText("Aparece en esta lista");
    await expect(created).toContainText("puedes abrirla para administrarla");
    await page.getByLabel("Buscar organización").fill(`Nueva ${token}`);
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page).toHaveURL(/[?&]search=/);
    await expect(
      page.getByRole("heading", { level: 2, name: `Nueva ${token}` }),
    ).toBeVisible();
    await app.shot("organization-created");
  });

  test("at 375px the platform lists neither scroll sideways nor lose the pagination at the bottom", async ({
    page,
    app,
  }) => {
    // The same narrow viewport in every project, so the guard also runs on
    // desktop projects: it is a layout contract, not a device check.
    const viewport = { width: 375, height: 812 };
    await page.setViewportSize(viewport);
    for (const [path, title] of [
      ["/organizations", "Organizaciones"],
      ["/admin", "Administración"],
    ] as const) {
      await app.openAs(login(people.platform), path);
      await expect(h1(page, title)).toBeVisible();
      const pagination = page.getByRole("group", { name: "Paginación" });
      await expect(pagination).toBeVisible();
      await expectSettled(page);
      await expectNoHorizontalOverflow(page);

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await expect(pagination).toBeInViewport({ ratio: 1 });
      // At the bottom of the screen, under the list: not wedged in the middle.
      const box = await pagination.boundingBox();
      expect(box, `${path} pagination box`).not.toBeNull();
      expect(
        box!.y + box!.height,
        `${path}: pagination ends in the lower part of the viewport`,
      ).toBeGreaterThan(viewport.height - 120);
    }
  });

  test("members: select, select all and bulk permissions survive a reload", async ({
    page,
    app,
  }) => {
    const s = await createScenario({ members: 3 });
    try {
      const [a, b, c] = s.members;
      await app.openAs(
        s.admin.credentials,
        `/organizations/${s.org.id}/members`,
      );
      await expect(h1(page, "Miembros")).toBeVisible();
      await expect(page.getByRole("link", { name: a.name })).toBeVisible();

      const bulk = page.getByRole("button", {
        name: "Editar permisos en bloque",
      });
      await expect(bulk).toBeDisabled();
      await page.getByRole("checkbox", { name: "Seleccionar todos" }).check();
      await expect(
        page.getByText("4 personas seleccionadas en esta página."),
      ).toBeVisible();
      await page.getByRole("checkbox", { name: "Seleccionar todos" }).uncheck();
      await expect(page.getByText(/Selecciona personas/)).toBeVisible();

      await page
        .getByRole("checkbox", { name: `Seleccionar a ${a.name}` })
        .check();
      await page
        .getByRole("checkbox", { name: `Seleccionar a ${b.name}` })
        .check();
      await expect(
        page.getByText("2 personas seleccionadas en esta página."),
      ).toBeVisible();
      await app.shot("organization-members-selected");
      await bulk.click();

      await expect(h1(page, "Editar permisos en bloque")).toBeVisible();
      await expect(page).toHaveURL(/userIds=/);
      await page.reload();
      await expect(h1(page, "Editar permisos en bloque")).toBeVisible();
      const chips = page.locator(".chip-list li");
      await expect(chips).toHaveCount(2);
      await expect(chips.filter({ hasText: a.name })).toHaveCount(1);
      await expectNoStateWordsInToggles(page);

      await page.getByRole("button", { name: "Leer facturas" }).click();
      await page.getByRole("button", { name: "Crear facturas" }).click();
      await expect(
        page.getByRole("button", { name: "Leer facturas" }),
      ).toHaveAttribute("aria-pressed", "true");
      await app.shot("organization-bulk-edited");
      await page.getByRole("button", { name: "Aplicar a 2 miembros" }).click();
      await expect(h1(page, "Miembros")).toBeVisible();
      const row = (name: string) =>
        page.getByRole("row", { name: new RegExp(name) });
      await expect(row(a.name)).toContainText("2 de 4 permisos");
      await expect(row(b.name)).toContainText("2 de 4 permisos");
      await expect(row(c.name)).toContainText("0 de 4 permisos");
    } finally {
      await s.dispose();
    }
  });

  test("adds an existing person by RUT", async ({ page, app }) => {
    const s = await createScenario({ members: 0 });
    const platform = await asPlatform();
    const rut = freshRut();
    const name = `Externa ${unique()}`;
    await platform.call("post", "/admin/users", {
      name,
      rut: rut.api,
      memberships: [],
      temporaryPassword: "Tmp-external-1",
    });
    await platform.dispose();
    try {
      await app.openAs(
        s.admin.credentials,
        `/organizations/${s.org.id}/members/new`,
      );
      await expect(h1(page, "Agregar miembro")).toBeVisible();
      await page.getByLabel("RUT de la persona").fill(rut.api);
      await page.getByRole("button", { name: "Agregar persona" }).click();
      await expect(
        notice(page, "Persona agregada a la organización."),
      ).toBeVisible();
      await expect(page.getByRole("link", { name })).toBeVisible();
    } finally {
      await s.dispose();
    }
  });

  test("the platform administrator gets the link to the administration wizard", async ({
    page,
    app,
  }) => {
    // Organization screens resolve through the person's own memberships, and
    // the platform administrator belongs to exactly one seeded organization:
    // it is read here, never given a new membership (seeded data is read-only).
    const ids = await seededIds();
    await app.openAs(
      login(people.platform),
      `/organizations/${ids.gamma.id}/members/new`,
    );
    await page.getByRole("tab", { name: "Crear persona nueva" }).click();
    const link = page.getByRole("link", {
      name: /¿Debe pertenecer a varias organizaciones o grupos a la vez\? Usa el asistente de administración/,
    });
    await expect(link).toHaveAttribute(
      "href",
      `/admin/users/new?organizationId=${ids.gamma.id}`,
    );
    // A text link, not a button.
    await expect(
      page.getByRole("button", { name: /varias organizaciones/ }),
    ).toHaveCount(0);
    await expect(link).toHaveCSS("text-decoration-line", "underline");
    await app.shot("add-member-new-platform-link");
    await link.click();
    await expect(h1(page, "Crear usuario")).toBeVisible();
  });

  test("member page: role, permissions, groups and removal with confirmation", async ({
    page,
    app,
  }) => {
    const s = await createScenario({ members: 1, groups: 2 });
    try {
      const [member] = s.members;
      await app.openAs(
        s.admin.credentials,
        `/organizations/${s.org.id}/members/${member.id}`,
      );
      await expect(h1(page, member.name)).toBeVisible();
      await expectNoStateWordsInToggles(page);

      await page.getByLabel(`Rol de ${member.name}`).selectOption("ADMIN");
      await expect(page.getByText("Rol actualizado.")).toBeVisible();
      await page.getByLabel(`Rol de ${member.name}`).selectOption("USER");

      const read = page.getByRole("button", { name: "Leer facturas" });
      await expect(read).toHaveAttribute("aria-pressed", "false");
      await read.click();
      await expect(read).toHaveAttribute("aria-pressed", "true");
      await page
        .getByRole("button", { name: `Guardar permisos de ${member.name}` })
        .click();
      await expect(page.getByText("Permisos guardados")).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Leer facturas" }),
      ).toHaveAttribute("aria-pressed", "true");

      await page.getByRole("button", { name: "Agregar al grupo" }).click();
      await expect(page.getByText("Persona agregada al grupo.")).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: "Grupos" }),
      ).toBeVisible();
      await app.shot("organization-member-with-group");

      await page
        .getByRole("button", {
          name: `Quitar a ${member.name} de la organización`,
        })
        .click();
      await app.shot("organization-member-confirm-remove");
      await page
        .getByRole("button", { name: `Confirmar quitar a ${member.name}` })
        .click();
      await expect(
        notice(page, `Se quitó a ${member.name} de la organización.`),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: member.name })).toHaveCount(
        0,
      );
    } finally {
      await s.dispose();
    }
  });
});
