import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchForm } from "./SearchForm";

afterEach(cleanup);

const box = () => screen.getByLabelText("Buscar") as HTMLInputElement;
const ui = (initial: string, onSearch = vi.fn()) => (
  <SearchForm label="Buscar" initial={initial} onSearch={onSearch} />
);

describe("SearchForm draft versus the committed term (CR-311)", () => {
  it("adopts a committed term that changes from outside while the box is clean (Back)", () => {
    const view = render(ui("ana"));
    expect(box().value).toBe("ana");
    view.rerender(ui(""));
    expect(box().value).toBe("");
    view.rerender(ui("luis"));
    expect(box().value).toBe("luis");
  });

  it("keeps text typed while the previous search is still being committed", () => {
    const onSearch = vi.fn();
    const view = render(ui("", onSearch));
    fireEvent.change(box(), { target: { value: "ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    expect(onSearch).toHaveBeenCalledWith("ana");
    // The user types the next term before the URL catches up...
    fireEvent.change(box(), { target: { value: "zzzz" } });
    // ...and the first search lands.
    view.rerender(ui("ana", onSearch));
    expect(box().value).toBe("zzzz");
  });

  it("does not overwrite an unsubmitted edit when the committed term changes", () => {
    const view = render(ui("ana"));
    fireEvent.change(box(), { target: { value: "ana m" } });
    view.rerender(ui("luis"));
    expect(box().value).toBe("ana m");
  });

  it("is clean again after submitting, so the next external change is adopted", () => {
    const onSearch = vi.fn();
    const view = render(ui("", onSearch));
    fireEvent.change(box(), { target: { value: " ana " } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    view.rerender(ui("ana", onSearch));
    expect(box().value).toBe("ana");
    view.rerender(ui("", onSearch));
    expect(box().value).toBe("");
  });
});

describe("SearchForm autoFocus (CR-405)", () => {
  it("focuses the box on mount in the default variant", () => {
    render(
      <SearchForm label="Buscar" initial="" onSearch={vi.fn()} autoFocus />,
    );
    expect(document.activeElement).toBe(box());
  });

  it("focuses the box on mount in the toolbar variant", () => {
    render(
      <SearchForm
        label="Buscar"
        initial=""
        onSearch={vi.fn()}
        variant="toolbar"
        autoFocus
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });

  it("does not take the focus by default", () => {
    render(ui(""));
    expect(document.activeElement).not.toBe(box());
  });
});
