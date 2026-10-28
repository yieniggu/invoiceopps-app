import { useCallback, useState } from "react";

/** Set of draft keys that are expanded (or collapsed, the caller decides). */
export function useKeySet(initial: Iterable<string> = []) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set(initial));
  const toggle = useCallback(
    (key: string) =>
      setKeys((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const replace = useCallback(
    (next: Iterable<string>) => setKeys(new Set(next)),
    [],
  );
  const add = useCallback(
    (added: Iterable<string>) =>
      setKeys((current) => new Set([...current, ...added])),
    [],
  );
  const remove = useCallback(
    (removed: Iterable<string>) =>
      setKeys((current) => {
        const next = new Set(current);
        for (const key of removed) next.delete(key);
        return next;
      }),
    [],
  );
  return { keys, toggle, replace, add, remove };
}
