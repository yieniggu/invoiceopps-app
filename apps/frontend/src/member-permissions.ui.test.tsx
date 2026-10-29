import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MemberPermissionsEditor,
  SavedMemberPermissionsEditor,
} from "./features/permissions/components/MemberPermissionsEditor";
import type { InvoicePermissions } from "./features/permissions/types";
import { renderWithIdentity } from "./test/renderWithIdentity";
import {
  NO_PERMISSIONS,
  deferred,
  errorResponse,
  jsonResponse,
  mockTransport,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FLAGS = [
  "Leer facturas",
  "Crear facturas",
  "Eliminar facturas propias",
  "Eliminar facturas de otros",
] as const;

function Draft({ initial = NO_PERMISSIONS }: { initial?: InvoicePermissions }) {
  const [value, setValue] = useState(initial);
  return (
    <MemberPermissionsEditor
      memberName="Ada Lovelace"
      level="organization"
      value={value}
      onChange={setValue}
    />
  );
}

// Each flag is a toggle button: aria-pressed carries its state.
const checked = (label: string) =>
  screen.getByRole("button", { name: label }).getAttribute("aria-pressed") ===
  "true";

describe("MemberPermissionsEditor, draft mode", () => {
  it("names the member and the level in the group legend", () => {
    renderWithIdentity(<Draft />);
    expect(
      screen.getByRole("group", {
        name: "Permisos en la organización — Ada Lovelace",
      }),
    ).toBeTruthy();
  });

  it("names the group level and the scope when the screen shows several", () => {
    renderWithIdentity(
      <MemberPermissionsEditor
        memberName="Ada Lovelace"
        level="group"
        scopeName="Contabilidad"
        value={NO_PERMISSIONS}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole("group", {
        name: "Permisos en el grupo «Contabilidad» — Ada Lovelace",
      }),
    ).toBeTruthy();
  });

  it("keeps the four flags independent and makes no request", () => {
    const transport = mockTransport({});
    renderWithIdentity(<Draft />);
    for (const label of FLAGS) expect(checked(label)).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Eliminar facturas de otros" }),
    );
    expect(FLAGS.map(checked)).toEqual([false, false, false, true]);
    fireEvent.click(screen.getByRole("button", { name: "Leer facturas" }));
    expect(FLAGS.map(checked)).toEqual([true, false, false, true]);
    fireEvent.click(
      screen.getByRole("button", { name: "Eliminar facturas de otros" }),
    );
    expect(FLAGS.map(checked)).toEqual([true, false, false, false]);
    expect(transport.requests).toEqual([]);
  });

  it("is made of native toggle buttons with aria-pressed in a fixed tab order", () => {
    renderWithIdentity(<Draft />);
    const toggles = FLAGS.map((label) =>
      screen.getByRole("button", { name: label }),
    ) as HTMLButtonElement[];
    expect(toggles.map((toggle) => toggle.type)).toEqual(
      Array(4).fill("button"),
    );
    expect(toggles.every((toggle) => toggle.tabIndex === 0)).toBe(true);
    expect(
      toggles.map((toggle) => toggle.getAttribute("aria-pressed")),
    ).toEqual(Array(4).fill("false"));
    toggles[2].focus();
    expect(document.activeElement).toBe(toggles[2]);
    // Native buttons activate with the keyboard (Enter and Space fire a click).
    fireEvent.click(toggles[2]);
    expect(toggles[2].getAttribute("aria-pressed")).toBe("true");
  });

  it("conveys the state by aria-pressed and the icon, with no state text", () => {
    renderWithIdentity(
      <Draft initial={{ ...NO_PERMISSIONS, readInvoices: true }} />,
    );
    const on = screen.getByRole("button", { name: "Leer facturas" });
    const off = screen.getByRole("button", { name: "Crear facturas" });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(off.getAttribute("aria-pressed")).toBe("false");
    expect(on.textContent).toBe("Leer facturas");
    expect(off.textContent).toBe("Crear facturas");
    // - turns an active flag off; + turns an inactive one on.
    expect(on.querySelector("svg.lucide-minus")).not.toBeNull();
    expect(off.querySelector("svg.lucide-plus")).not.toBeNull();
    fireEvent.click(off);
    expect(off.getAttribute("aria-pressed")).toBe("true");
    expect(off.textContent).toBe("Crear facturas");
  });

  it("marks and unmarks every flag at once", () => {
    const transport = mockTransport({});
    renderWithIdentity(<Draft />);
    fireEvent.click(screen.getByRole("button", { name: "Marcar todos" }));
    expect(FLAGS.map(checked)).toEqual([true, true, true, true]);
    fireEvent.click(screen.getByRole("button", { name: "Desmarcar todos" }));
    expect(FLAGS.map(checked)).toEqual([false, false, false, false]);
    expect(transport.requests).toEqual([]);
  });

  it("folds behind a chevron and summarizes how many flags are on", () => {
    renderWithIdentity(
      <MemberPermissionsEditor
        memberName="Ada"
        level="organization"
        value={{ ...NO_PERMISSIONS, readInvoices: true, createInvoices: true }}
        onChange={() => {}}
        collapsible
        defaultOpen={false}
      />,
    );
    const fold = screen.getByRole("button", { name: /Ver permisos/ });
    expect(fold.textContent).toContain("2 de 4 permisos");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Leer facturas" })).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(checked("Leer facturas")).toBe(true);
  });

  it("locks every flag while disabled", () => {
    renderWithIdentity(
      <MemberPermissionsEditor
        memberName="Ada"
        level="organization"
        value={NO_PERMISSIONS}
        onChange={() => {}}
        disabled
      />,
    );
    const group = screen.getByRole("group");
    const controls = within(group).getAllByRole("button");
    // Four toggles plus "Marcar todos" and "Desmarcar todos".
    expect(controls).toHaveLength(6);
    for (const control of controls)
      expect(control.matches(":disabled")).toBe(true);
  });
});

describe("MemberPermissionsEditor, saved mode", () => {
  const PUT =
    "PUT /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000003/permissions";
  const target = {
    level: "organization" as const,
    organizationId: "00000000-0000-4000-9000-000000000001",
    userId: "00000000-0000-4000-8000-000000000003",
  };
  const renderSaved = (saved = NO_PERMISSIONS) =>
    renderWithIdentity(
      <SavedMemberPermissionsEditor
        memberName="Carla Soto"
        target={target}
        saved={saved}
      />,
    );
  const save = () =>
    screen.getByRole("button", { name: "Guardar permisos de Carla Soto" });

  it("enables Guardar only when the draft differs from the saved flags", () => {
    mockTransport({});
    renderSaved({ ...NO_PERMISSIONS, readInvoices: true });
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Crear facturas" }));
    expect(save()).toHaveProperty("disabled", false);
    // Going back to the saved value makes it clean again.
    fireEvent.click(screen.getByRole("button", { name: "Crear facturas" }));
    expect(save()).toHaveProperty("disabled", true);
  });

  it("PUTs the four flags, locks the controls while pending and announces the result", async () => {
    const gate = deferred<Response>();
    const transport = mockTransport({ [PUT]: () => gate.promise });
    renderSaved();
    fireEvent.click(screen.getByRole("button", { name: "Crear facturas" }));
    fireEvent.click(save());
    const status = await screen.findByText("Guardando…");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(save()).toHaveProperty("disabled", true);
    expect(
      screen
        .getByRole("button", { name: "Leer facturas" })
        .matches(":disabled"),
    ).toBe(true);
    // A second click while pending sends nothing more.
    fireEvent.click(save());
    expect(transport.calls(PUT)).toHaveLength(1);
    expect(transport.calls(PUT)[0].body).toEqual({
      permissions: { ...NO_PERMISSIONS, createInvoices: true },
    });
    await act(async () => gate.resolve(jsonResponse({ membership: {} })));
    expect(await screen.findByText("Permisos guardados")).toBeTruthy();
    expect(screen.queryByText("Guardando…")).toBeNull();
  });

  it("keeps the draft and says why when saving fails", async () => {
    mockTransport({ [PUT]: () => errorResponse(403, "FORBIDDEN") });
    renderSaved();
    fireEvent.click(screen.getByRole("button", { name: "Leer facturas" }));
    fireEvent.click(save());
    expect(
      await screen.findByText("No tienes permiso para realizar esta acción."),
    ).toBeTruthy();
    expect(checked("Leer facturas")).toBe(true);
    // The draft is still dirty, so the person can retry.
    expect(save()).toHaveProperty("disabled", false);
  });

  it("shows a retry message for a busy system (503) and saves on retry", async () => {
    let busy = true;
    const transport = mockTransport({
      [PUT]: () =>
        busy
          ? errorResponse(503, "RETRYABLE_CONFLICT")
          : jsonResponse({ membership: {} }),
    });
    renderSaved();
    fireEvent.click(screen.getByRole("button", { name: "Crear facturas" }));
    fireEvent.click(save());
    expect(
      await screen.findByText(
        "El sistema está ocupado. Intenta nuevamente en unos segundos.",
      ),
    ).toBeTruthy();
    expect(checked("Crear facturas")).toBe(true);
    busy = false;
    fireEvent.click(save());
    expect(await screen.findByText("Permisos guardados")).toBeTruthy();
    expect(transport.calls(PUT)).toHaveLength(2);
  });

  it("retires the previous outcome as soon as the person edits again", async () => {
    mockTransport({ [PUT]: () => jsonResponse({ membership: {} }) });
    renderSaved();
    fireEvent.click(screen.getByRole("button", { name: "Crear facturas" }));
    fireEvent.click(save());
    await screen.findByText("Permisos guardados");
    fireEvent.click(screen.getByRole("button", { name: "Leer facturas" }));
    await waitFor(() =>
      expect(screen.queryByText("Permisos guardados")).toBeNull(),
    );
  });

  it("uses the group endpoint at group level", async () => {
    const transport = mockTransport({
      "PUT /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships/00000000-0000-4000-8000-000000000003/permissions":
        () => jsonResponse({ membership: {} }),
    });
    renderWithIdentity(
      <SavedMemberPermissionsEditor
        memberName="Carla Soto"
        target={{
          level: "group",
          organizationId: "00000000-0000-4000-9000-000000000001",
          groupId: "00000000-0000-4000-a000-000000000097",
          userId: "00000000-0000-4000-8000-000000000003",
        }}
        saved={NO_PERMISSIONS}
      />,
    );
    const editor = screen.getByRole("group", {
      name: "Permisos en el grupo — Carla Soto",
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Leer facturas" }),
    );
    fireEvent.click(save());
    await screen.findByText("Permisos guardados");
    expect(transport.requests.map(({ method }) => method)).toEqual(["PUT"]);
  });
});
