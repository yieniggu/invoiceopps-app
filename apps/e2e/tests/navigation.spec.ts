import { expect, test } from "../support/test.ts";
import {
  sidebarNav,
  expectPoliciesItemLayout,
  expectSidebarLabelsSingleLine,
} from "../support/layout.ts";
import { login, people } from "../support/seeded.ts";

const mobileProject = (name: string) => name === "mobile";

test.describe("navigation shell", () => {
  test("sidebar labels stay on one line and Políticas shows its badge below", async ({
    page,
    app,
  }, testInfo) => {
    await app.openAs(login(people.carla), "/dashboard");
    if (mobileProject(testInfo.project.name)) {
      await page.getByRole("button", { name: "Abrir menú" }).click();
    }
    await expect(page.locator("#app-sidebar")).toBeVisible();
    await expectPoliciesItemLayout(page);
    await expectSidebarLabelsSingleLine(page);
    await app.shot("sidebar-policies");
  });

  test("main content starts next to the sidebar, left aligned", async ({
    page,
    app,
  }, testInfo) => {
    await app.openAs(login(people.carla), "/dashboard");
    const title = await page
      .getByRole("heading", { level: 1, name: "Panel principal" })
      .boundingBox();
    const sidebar = await page.locator("#app-sidebar").boundingBox();
    expect(title).not.toBeNull();
    if (mobileProject(testInfo.project.name)) {
      // 16px gutter on phones.
      expect(title!.x).toBeGreaterThanOrEqual(16);
      expect(title!.x).toBeLessThanOrEqual(24);
    } else {
      const gap = title!.x - (sidebar!.x + sidebar!.width);
      expect(gap).toBeGreaterThanOrEqual(16);
      expect(gap).toBeLessThanOrEqual(40);
    }
  });

  test("collapses the sidebar and remembers it, or opens the drawer on phones", async ({
    page,
    app,
  }, testInfo) => {
    await app.openAs(login(people.carla), "/dashboard");
    if (mobileProject(testInfo.project.name)) {
      const sidebar = page.locator("#app-sidebar");
      await expect(sidebar).toBeHidden();
      await page.getByRole("button", { name: "Abrir menú" }).click();
      await expect(sidebar).toBeVisible();
      await app.shot("drawer-open");
      await page.keyboard.press("Escape");
      await expect(sidebar).toBeHidden();
      await page.getByRole("button", { name: "Abrir menú" }).click();
      await sidebarNav(page)
        .getByRole("link", { name: "Organizaciones", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Organizaciones" }),
      ).toBeVisible();
      await expect(sidebar).toBeHidden();
      return;
    }
    const sidebar = page.locator("#app-sidebar");
    const before = (await sidebar.boundingBox())!.width;
    await page.getByRole("button", { name: "Contraer menú" }).click();
    await expect
      .poll(async () => (await sidebar.boundingBox())!.width)
      .toBeLessThan(before / 2);
    await expect(
      sidebarNav(page).getByRole("link", { name: "Facturas", exact: true }),
    ).toBeVisible();
    await app.shot("sidebar-collapsed");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Expandir menú" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Expandir menú" }).click();
    await expect(
      page.getByRole("button", { name: "Contraer menú" }),
    ).toBeVisible();
    await expectPoliciesItemLayout(page);
  });

  test("the theme toggle switches and persists the theme", async ({
    page,
    app,
  }, testInfo) => {
    await app.openAs(login(people.carla), "/dashboard");
    const html = page.locator("html");
    if (mobileProject(testInfo.project.name)) {
      await expect(html).toHaveAttribute("data-theme", "light");
    }
    await page.getByRole("button", { name: "Usar tema oscuro" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Usar tema claro" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await page
      .getByRole("button", { name: "Usar preferencia del sistema" })
      .click();
    await expect(html).toHaveAttribute(
      "data-theme",
      testInfo.project.name === "desktop-dark" ? "dark" : "light",
    );
  });

  test("the Políticas screen and sidebar item are disabled", async ({
    page,
    app,
  }, testInfo) => {
    await app.openAs(login(people.carla), "/policies");
    await expect(
      page.getByRole("heading", { level: 1, name: "Políticas" }),
    ).toBeVisible();
    await expect(page.getByText("No disponible por ahora.")).toBeVisible();
    if (mobileProject(testInfo.project.name)) {
      await page.getByRole("button", { name: "Abrir menú" }).click();
    }
    const item = page.getByRole("button", { name: /^Políticas/ });
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(item).toContainText("Próximamente");
    await expect(page.getByRole("link", { name: "Políticas" })).toHaveCount(0);
  });

  for (const route of ["/organizaciones", "/facturas", "/grupos", "/perfil"]) {
    test(`the old Spanish route ${route} is not found`, async ({
      page,
      app,
    }) => {
      await app.openAs(login(people.carla), route);
      await expect(
        page.getByRole("heading", { level: 1, name: "Página no encontrada" }),
      ).toBeVisible();
    });
  }
});
