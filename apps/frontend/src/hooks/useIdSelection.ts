import { useCallback, useState } from "react";

/**
 * Which rows of a list are ticked. The state only holds the person's choices;
 * what counts as selected is always intersected with the ids on screen, so a
 * refetch that drops a row also drops it from the selection (no copy of the
 * query data is kept).
 *
 * `scope` names what the rows belong to (the page of a paginated list): when
 * it changes the selection is cleared, so a count or a bulk action never
 * carries people the person can no longer see.
 */
export function useIdSelection(
  visibleIds: readonly string[],
  scope?: string | number,
) {
  const [state, setState] = useState<{
    scope: typeof scope;
    ids: ReadonlySet<string>;
  }>({ scope, ids: new Set() });
  // Setting state while rendering is safe here: the guard is false next pass.
  if (state.scope !== scope) setState({ scope, ids: new Set() });
  const chosen = state.scope === scope ? state.ids : new Set<string>();
  const setChosen = (
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => setState((current) => ({ ...current, ids: update(current.ids) }));
  const selected = visibleIds.filter((id) => chosen.has(id));
  const allSelected =
    visibleIds.length > 0 && selected.length === visibleIds.length;

  const toggle = useCallback(
    (id: string) =>
      setChosen((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const toggleAll = () =>
    setChosen((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  return {
    selected,
    isSelected: (id: string) => chosen.has(id),
    allSelected,
    someSelected: selected.length > 0 && !allSelected,
    toggle,
    toggleAll,
  };
}
