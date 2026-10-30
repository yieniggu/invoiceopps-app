import { Search, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

/**
 * Search box that commits on submit (Enter or «Buscar»). The draft is local;
 * the committed term lives in the URL (`initial`). When the committed term
 * changes from outside (Back, a link) the box adopts it, unless the user has
 * an unsubmitted edit: text typed while a previous search is still landing is
 * never overwritten. Do not remount it with `key={committed}`: that is what
 * used to drop the draft.
 */
export function SearchForm({
  label,
  initial,
  onSearch,
  maxLength,
  variant = "default",
  autoFocus = false,
}: {
  label: string;
  initial: string;
  onSearch: (search: string) => void;
  /** Longest text the endpoint accepts; the box refuses more. */
  maxLength?: number;
  /**
   * `toolbar`: one compact field for a filter row. The label becomes the
   * placeholder and accessible name, a search icon button submits and an «x»
   * clears (and searches for nothing). Same draft and commit rules.
   */
  variant?: "default" | "toolbar";
  /**
   * Focus the box when it mounts (a remount that must not lose the focus).
   * Honoured by both variants.
   */
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [committed, setCommitted] = useState(initial);
  if (initial !== committed) {
    setCommitted(initial);
    if (!dirty || draft.trim() === initial) {
      setDraft(initial);
      setDirty(false);
    }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDirty(false);
    onSearch(draft.trim());
  };
  if (variant === "toolbar")
    return (
      <form onSubmit={submit} role="search" className="toolbar-search">
        <button
          type="submit"
          className="toolbar-search-submit"
          aria-label="Buscar"
        >
          <Search aria-hidden="true" focusable="false" size={18} />
        </button>
        <input
          ref={input}
          type="search"
          autoFocus={autoFocus}
          aria-label={label}
          placeholder={label}
          maxLength={maxLength}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(event.target.value.trim() !== initial);
          }}
        />
        {draft !== "" ? (
          <button
            type="button"
            className="toolbar-search-clear"
            aria-label="Borrar búsqueda"
            onClick={() => {
              setDraft("");
              setDirty(false);
              onSearch("");
              input.current?.focus();
            }}
          >
            <X aria-hidden="true" focusable="false" size={16} />
          </button>
        ) : null}
      </form>
    );
  return (
    <form onSubmit={submit} role="search" className="action-row search-form">
      <label>
        {label}
        <input
          type="search"
          autoFocus={autoFocus}
          maxLength={maxLength}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(event.target.value.trim() !== initial);
          }}
        />
      </label>
      <button type="submit">Buscar</button>
    </form>
  );
}
