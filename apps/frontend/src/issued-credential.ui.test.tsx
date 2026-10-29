import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  IssuedCredentialProvider,
  usePresentIssuedCredential,
} from "./features/users/components/IssuedCredentialProvider";

afterEach(cleanup);

const first = {
  userId: "00000000-0000-4000-8000-000000000001",
  name: "Diego Rojas",
  temporaryPassword: "Tmp-First-1111",
};
const second = {
  userId: "00000000-0000-4000-8000-000000000002",
  name: "Elena Soto",
  temporaryPassword: "Tmp-Second-2222",
};

function Page({ disabledTarget = false }: { disabledTarget?: boolean }) {
  const present = usePresentIssuedCredential();
  const target = useRef<HTMLButtonElement>(null);
  const missing = useRef<HTMLButtonElement>(null);
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Crear usuario
      </h1>
      <button type="button" onClick={() => present(first)}>
        Emitir primera
      </button>
      <button type="button" onClick={() => present(second)}>
        Emitir segunda
      </button>
      <button ref={target} type="button" disabled={disabledTarget}>
        Creando...
      </button>
      <button type="button" onClick={() => present(first, target)}>
        Emitir con destino
      </button>
      <button type="button" onClick={() => present(first, missing)}>
        Emitir sin destino
      </button>
    </>
  );
}

const open = (props: { disabledTarget?: boolean } = {}) =>
  render(
    <IssuedCredentialProvider>
      <Page {...props} />
    </IssuedCredentialProvider>,
  );
const confirm = () =>
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Ya copié la contraseña",
    }),
  );

describe("IssuedCredentialProvider (CR-257)", () => {
  it("queues a second credential instead of replacing the one not yet confirmed", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Emitir primera" }));
    fireEvent.click(screen.getByRole("button", { name: "Emitir segunda" }));

    // Only the first is shown, and the second has not replaced it.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText(first.temporaryPassword)).toBeTruthy();
    expect(document.body.textContent).not.toContain(second.temporaryPassword);

    confirm();
    // The queued one appears right after, never lost.
    expect(screen.getByText(second.temporaryPassword)).toBeTruthy();
    expect(document.body.textContent).not.toContain(first.temporaryPassword);
    expect(
      screen.getByText(/Entrega esta contraseña a Elena Soto/),
    ).toBeTruthy();

    confirm();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(second.temporaryPassword);
  });

  it("queues two credentials of the same person as separate dialogs", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Emitir primera" }));
    fireEvent.click(screen.getByRole("button", { name: "Emitir primera" }));
    confirm();
    expect(screen.getByRole("dialog")).toBeTruthy();
    confirm();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("falls back to the page title when the focus target does not exist yet", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Emitir sin destino" }));
    confirm();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1 }),
    );
  });

  it("falls back to the page title when the focus target is a disabled button", () => {
    open({ disabledTarget: true });
    fireEvent.click(screen.getByRole("button", { name: "Emitir con destino" }));
    confirm();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1 }),
    );
  });

  it("returns focus to an enabled target", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Emitir con destino" }));
    confirm();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Creando..." }),
    );
  });
});
