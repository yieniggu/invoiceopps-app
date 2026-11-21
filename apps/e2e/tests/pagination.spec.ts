import {
  expect,
  expectNoHorizontalOverflow,
  expectSettled,
  test,
} from "../support/test.ts";
import {
  expectPagerAtBottom,
  expectSelectionCount,
} from "../support/layout.ts";
import { seedInvoices } from "../support/invoices.ts";
import {
  ALL_FLAGS,
  createScenario,
  NO_FLAGS,
  people,
} from "../support/scenario.ts";
import { login } from "../support/seeded.ts";

import { Api } from "../support/api.ts";

import type { Page } from "@playwright/test";

const h1 = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

// One test per kind of data, run by every project (desktop, mobile and dark):
// the seven screens that render `PaginationControls` keep the pager as the
// last block of the screen (or of the step, above its action bar), at the
// bottom, with a short list, an empty one or a long page.
test.describe("the paginator is always at the bottom", () => {
  test("platform: organization directory and user administration", async ({
    page,
    app,
  }) => {
    for (const [path, title] of [
      ["/organizations", "Organizaciones"],
      ["/admin", "Administración"],
    ] as const) {
      await app.openAs(login(people.platform), path);
      await expect(h1(page, title)).toBeVisible();
      await expectSettled(page);
      await expectNoHorizontalOverflow(page);
      await expectPagerAtBottom(page, path);
    }
  });

  test("invoice inbox", async ({ page, app }) => {
    await app.openAs(login(people.carla), "/invoices");
    await expect(h1(page, "Facturas")).toBeVisible();
    await expectSettled(page);
    await expectPagerAtBottom(page, "/invoices");
  });

  test("invoice inbox with a long list: two pages, pager at the bottom of each", async ({
    page,
    app,
  }) => {
    // A private organization with more invoices than one page holds (20).
    const s = await createScenario({ members: 1, memberFlags: ALL_FLAGS });
    const [member] = s.members;
    const reader = await Api.signIn(member.credentials);
    try {
      await seedInvoices(reader, s.org.id, 25, "LONG");
      await app.openAs(member.credentials, "/invoices");
      await expect(h1(page, "Facturas")).toBeVisible();
      await expectSettled(page);
      const pager = page.getByRole("group", { name: "Paginación" });
      await expect(pager).toContainText("Página 1 de 2");
      await expectPagerAtBottom(page, "/invoices, long page 1");
      await app.shot("pager-invoices-long-page-1");

      await pager.getByRole("button", { name: /Siguiente/ }).click();
      await expect(pager).toContainText("Página 2 de 2");
      await expectSettled(page);
      await expectPagerAtBottom(page, "/invoices, long page 2");
    } finally {
      await reader.dispose();
      await s.dispose();
    }
  });

  test("organization and group members, API tokens and the add-members step", async ({
    page,
    app,
  }) => {
    const s = await createScenario({
      members: 2,
      groups: 2,
      memberFlags: NO_FLAGS,
    });
    try {
      const [withMember, empty] = s.groups;
      await s.api.call(
        "post",
        `/organizations/${s.org.id}/groups/${withMember.id}/memberships/bulk`,
        {
          members: [
            {
              userId: s.members[0].id,
              permissions: {
                readInvoices: true,
                createInvoices: false,
                deleteOwnInvoices: false,
                deleteOthersInvoices: false,
                deployModels: false,
              },
            },
          ],
        },
      );
      const org = `/organizations/${s.org.id}`;

      for (const [label, path, title] of [
        ["api-tokens", "/api-tokens", "Tokens de API"],
        ["organization-members", `${org}/members`, "Miembros"],
        [
          "group-members",
          `${org}/groups/${withMember.id}/members`,
          new RegExp(`Miembros|${withMember.name}`),
        ],
      ] as const) {
        await app.openAs(s.admin.credentials, path);
        await expect(h1(page, title)).toBeVisible();
        await expectSettled(page);
        await expectNoHorizontalOverflow(page);
        await expectPagerAtBottom(page, label);
        await app.shot(`pager-${label}`);
      }

      // The step: pager right above the action bar (the summary of the picked
      // people and the submit), with nobody, one and two people picked.
      const step = `${org}/groups/${empty.id}/members/new`;
      await app.openAs(s.admin.credentials, step);
      await expect(h1(page, "Agregar miembros al grupo")).toBeVisible();
      await expectSettled(page);
      await expectPagerAtBottom(page, "add-members", { actionBar: true });

      await page.getByRole("checkbox", { name: /Persona1/ }).check();
      await expectSelectionCount(page, 1);
      await expectNoHorizontalOverflow(page);
      await expectPagerAtBottom(page, "add-members with one person picked", {
        actionBar: true,
      });
      await app.shot("pager-add-members-one-selected");

      // Picking a second person never moves the row that was clicked: the
      // picked people sit under the pager, behind a folded one-line summary.
      const second = page.getByRole("checkbox", { name: /Persona2/ });
      await second.scrollIntoViewIfNeeded();
      const before = await second.boundingBox();
      await second.check();
      await expectSelectionCount(page, 2);
      const after = await second.boundingBox();
      expect(before && after).toBeTruthy();
      expect(
        Math.abs(after!.y - before!.y),
        "the clicked checkbox stays where it was",
      ).toBeLessThanOrEqual(4);
      await expect(
        page.getByRole("button", {
          name: "2 personas seleccionadas · Ajustar permisos",
        }),
      ).toHaveAttribute("aria-expanded", "false");
      await expectNoHorizontalOverflow(page);
      await expectPagerAtBottom(page, "add-members with two people picked", {
        actionBar: true,
      });
      await app.shot("pager-add-members-two-selected");
    } finally {
      await s.dispose();
    }
  });

  // 25 members plus the admin: 26 candidates, two pages of 20.
  test("add-members step with more than one page of candidates", async ({
    page,
    app,
  }) => {
    test.setTimeout(120_000);
    const s = await createScenario({
      members: 25,
      groups: 1,
      memberFlags: NO_FLAGS,
    });
    try {
      const [group] = s.groups;
      await app.openAs(
        s.admin.credentials,
        `/organizations/${s.org.id}/groups/${group.id}/members/new`,
      );
      await expect(h1(page, "Agregar miembros al grupo")).toBeVisible();
      await expectSettled(page);
      const pager = page.getByRole("group", { name: "Paginación" });
      const rows = page.locator(".checkbox-list").getByRole("checkbox");
      await expect(pager).toContainText("Página 1 de 2");
      await expect(rows).toHaveCount(20);
      await expectPagerAtBottom(page, "add-members page 1", {
        actionBar: true,
      });

      // Pick the first person of page 1, then go to page 2.
      await rows.first().check();
      await expectSelectionCount(page, 1);
      await pager.getByRole("button", { name: /Siguiente/ }).click();
      await expect(pager).toContainText("Página 2 de 2");
      await expectSettled(page);
      await expect(rows).toHaveCount(6);
      await expectNoHorizontalOverflow(page);
      await expectPagerAtBottom(page, "add-members page 2", {
        actionBar: true,
      });
      await app.shot("pager-add-members-page-2");

      // The pick of page 1 survives, and page 2 adds to it.
      await rows.first().check();
      await expectSelectionCount(page, 2);
      await expectPagerAtBottom(page, "add-members page 2 with a pick", {
        actionBar: true,
      });
      await pager.getByRole("button", { name: /Anterior/ }).click();
      await expect(pager).toContainText("Página 1 de 2");
      await expectSettled(page);
      await expect(rows.first()).toBeChecked();
      await expectSelectionCount(page, 2);
      await expectPagerAtBottom(page, "add-members page 1 again", {
        actionBar: true,
      });

      // The action bar is the `[data-action-bar]` block (the disclosure of the
      // picked people) and the submit under it. Unfolded, the disclosure grows
      // *below* the pager: the pager is still the last block of the list area
      // and directly above the action bar, with no gap but the form's own.
      const toggle = page.getByRole("button", {
        name: "2 personas seleccionadas · Ajustar permisos",
      });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByRole("heading", {
          name: "Aplicar los mismos permisos a todos",
        }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectPagerAtBottom(page, "add-members with the disclosure open", {
        actionBar: true,
      });
      const pagerBox = await pager.boundingBox();
      const barBox = await page.locator("[data-action-bar]").boundingBox();
      expect(pagerBox && barBox).toBeTruthy();
      const gap = barBox!.y - (pagerBox!.y + pagerBox!.height);
      expect(
        gap,
        "the action bar starts right under the pager",
      ).toBeGreaterThanOrEqual(-1);
      expect(
        gap,
        "the action bar starts right under the pager",
      ).toBeLessThanOrEqual(24);
      await app.shot("pager-add-members-disclosure-open");
    } finally {
      await s.dispose();
    }
  });
});
