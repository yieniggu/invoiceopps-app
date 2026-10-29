import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toast } from "../../components/Toast";
import { AppShell } from "./AppShell";
import { useRouteNotice } from "./useRouteNotice";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Origin() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        navigate("/destino", { state: { notice: "Persona agregada." } })
      }
    >
      Ir
    </button>
  );
}

function Destination() {
  const notice = useRouteNotice();
  const navigate = useNavigate();
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Destino
      </h1>
      <button
        type="button"
        onClick={() =>
          navigate("/destino", { state: { notice: "Persona agregada." } })
        }
      >
        Repetir
      </button>
      <Toast message={notice.message} noticeId={notice.id} />
    </>
  );
}

function renderFlow() {
  return render(
    <MemoryRouter initialEntries={["/origen"]}>
      <AppShell onLogout={() => undefined} isLoggingOut={false}>
        <Routes>
          <Route path="/origen" element={<Origin />} />
          <Route path="/destino" element={<Destination />} />
        </Routes>
      </AppShell>
    </MemoryRouter>,
  );
}

const liveRegion = () =>
  document.querySelector<HTMLElement>('[aria-live="polite"]');

/** Records every text the region holds, in order, from now on. */
function recordAnnouncements(region: HTMLElement) {
  const texts: string[] = [];
  const observer = new MutationObserver(() => {
    if (region.textContent) texts.push(region.textContent);
  });
  observer.observe(region, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return { texts, observer };
}

describe("route notice announcement", () => {
  it("has a persistent empty polite region before the notice text is written into it", async () => {
    renderFlow();
    const region = liveRegion();
    expect(region).not.toBeNull();
    expect(region!.textContent).toBe("");
    // Outside `main`, so an open drawer (inert main) cannot silence it.
    expect(screen.getByRole("main").contains(region)).toBe(false);
    expect(region!.closest("[inert]")).toBeNull();

    const { texts, observer } = recordAnnouncements(region!);
    fireEvent.click(screen.getByRole("button", { name: "Ir" }));
    await act(async () => {});
    observer.disconnect();

    // The very node that existed (empty) before the text received it.
    expect(liveRegion()).toBe(region);
    expect(region!.textContent).toBe("Persona agregada.");
    expect(texts).toContain("Persona agregada.");
    // The visible card is not a second live region: no double announcement.
    const card = screen.getByRole("button", {
      name: "Cerrar aviso",
    }).parentElement!;
    expect(card.closest("[aria-live]")).toBeNull();
    expect(card.closest('[role="status"]')).toBeNull();
  });

  it("announces an identical notice again, and clears it on dismissal", async () => {
    renderFlow();
    const region = liveRegion()!;
    fireEvent.click(screen.getByRole("button", { name: "Ir" }));
    await act(async () => {});
    expect(region.textContent).toBe("Persona agregada.");
    const first = region.firstElementChild;

    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(region.textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Repetir" }));
    await act(async () => {});
    expect(region.textContent).toBe("Persona agregada.");
    // A fresh node, which is what makes a screen reader speak it again.
    expect(region.firstElementChild).not.toBe(first);
  });

  it("keeps the auto-dismiss from moving focus and clears the region", async () => {
    vi.useFakeTimers();
    renderFlow();
    const region = liveRegion()!;
    fireEvent.click(screen.getByRole("button", { name: "Ir" }));
    await act(async () => {});
    const other = screen.getByRole("button", { name: "Repetir" });
    other.focus();
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(region.textContent).toBe("");
    expect(document.activeElement).toBe(other);
  });
});
