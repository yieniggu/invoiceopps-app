import { useState, type FormEvent } from "react";

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
}: {
  label: string;
  initial: string;
  onSearch: (search: string) => void;
}) {
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
  return (
    <form onSubmit={submit} role="search" className="action-row search-form">
      <label>
        {label}
        <input
          type="search"
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
