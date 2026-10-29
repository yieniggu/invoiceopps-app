import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRouteNotice } from "../features/navigation/useRouteNotice";
import { Toast, toastDuration } from "./Toast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toast", () => {
  it("shows the message as a polite status and closes on demand", () => {
    render(<Toast message="Organización «Test 1» creada." />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Organización «Test 1» creada.");
    expect(status.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(screen.queryByText("Organización «Test 1» creada.")).toBeNull();
  });

  it("keeps the polite live region mounted with no message, so a later text is announced", () => {
    const { rerender } = render(<Toast message={undefined} />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    // The very same node receives the text: it is not inserted with it.
    rerender(<Toast message="Listo." />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toContain("Listo.");
    rerender(<Toast message={undefined} />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("");
  });

  it("dismisses itself after a few seconds, but not while hovered", () => {
    vi.useFakeTimers();
    render(<Toast message="Listo." />);
    const status = screen.getByRole("status");
    fireEvent.mouseEnter(status);
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.queryByText("Listo.")).not.toBeNull();
    fireEvent.mouseLeave(status);
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(screen.queryByText("Listo.")).toBeNull();
  });

  it("stays longer for a long message: at least 6 s, 60 ms per character", () => {
    expect(toastDuration("Corto")).toBe(6000);
    const long = Array.from(
      { length: 6 },
      () => "Se agregaron las personas al grupo y se actualizó.",
    ).join(" ");
    expect(long.length).toBeGreaterThan(100);
    expect(toastDuration(long)).toBe(long.length * 60);

    vi.useFakeTimers();
    render(<Toast message={long} />);
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(screen.queryByText(long)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(long.length * 60);
    });
    expect(screen.queryByText(long)).toBeNull();
  });

  it("moves focus to the page title when the close button removes the card", () => {
    render(
      <>
        <h1 id="page-title" tabIndex={-1}>
          Título
        </h1>
        <Toast message="Listo." />
      </>,
    );
    const close = screen.getByRole("button", { name: "Cerrar aviso" });
    close.focus();
    fireEvent.click(close);
    expect(document.activeElement).toBe(screen.getByRole("heading"));
  });

  it("falls back to main when the page has no title", () => {
    render(
      <>
        <main tabIndex={-1}>contenido</main>
        <Toast message="Listo." />
      </>,
    );
    const close = screen.getByRole("button", { name: "Cerrar aviso" });
    close.focus();
    fireEvent.click(close);
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("shows the same text again for a new arrival, tracking dismissal by notice id", () => {
    const { rerender } = render(<Toast message="Listo." noticeId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(screen.queryByText("Listo.")).toBeNull();
    // Same notice re-rendered: still dismissed.
    rerender(<Toast message="Listo." noticeId="a" />);
    expect(screen.queryByText("Listo.")).toBeNull();
    // The same text arriving again is another notice.
    rerender(<Toast message="Listo." noticeId="b" />);
    expect(screen.queryByText("Listo.")).not.toBeNull();
  });
});

describe("useRouteNotice with Toast", () => {
  function Screen() {
    const notice = useRouteNotice();
    const navigate = useNavigate();
    return (
      <>
        <button
          type="button"
          onClick={() =>
            navigate("/lista", { state: { notice: "Persona agregada." } })
          }
        >
          Repetir
        </button>
        <Toast message={notice.message} noticeId={notice.id} />
      </>
    );
  }

  it("shows an identical notice again after it was dismissed", () => {
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: "/lista", state: { notice: "Persona agregada." } },
        ]}
      >
        <Routes>
          <Route path="/lista" element={<Screen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText("Persona agregada.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(screen.queryByText("Persona agregada.")).toBeNull();
    // Another arrival at the same screen with the very same text.
    fireEvent.click(screen.getByRole("button", { name: "Repetir" }));
    expect(screen.queryByText("Persona agregada.")).not.toBeNull();
  });
});
