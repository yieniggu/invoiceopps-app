import { useCallback, useState } from "react";

/**
 * Which rows of a list are ticked. The state only holds the person's choices;
 * what counts as selected is always intersected with the ids on screen, so a
 * refetch that drops a row also drops it from the selection (no copy of the
 * query data is kept).
 */
export function useIdSelection(visibleIds: readonly string[]) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
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
