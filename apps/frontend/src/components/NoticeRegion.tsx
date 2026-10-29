import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface Announcement {
  id: string;
  text: string;
}

interface Announcer {
  /** Writes `text` into the persistent region; `id` is one arrival. */
  announce: (id: string, text: string) => void;
  /** Empties the region, but only while it still holds that arrival. */
  clear: (id: string) => void;
}

const AnnouncerContext = createContext<Announcer | null>(null);

/** The announcer of the surrounding shell, or `null` outside of one. */
export const useAnnouncer = () => useContext(AnnouncerContext);

/**
 * One polite live region that is mounted with the shell and starts empty. A
 * region inserted together with its text is not reliably announced, so a
 * notice is written into this one after it already exists. Each arrival is its
 * own node (keyed by id), which makes an identical text speak again.
 *
 * It renders outside `main`, so an open drawer (which makes `main` inert)
 * cannot silence it.
 */
export function NoticeRegionProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Announcement | null>(null);
  const announce = useCallback(
    (id: string, text: string) => setCurrent({ id, text }),
    [],
  );
  const clear = useCallback(
    (id: string) =>
      setCurrent((existing) => (existing?.id === id ? null : existing)),
    [],
  );
  const announcer = useMemo(() => ({ announce, clear }), [announce, clear]);

  return (
    <AnnouncerContext.Provider value={announcer}>
      {children}
      <div
        className="visually-hidden"
        aria-live="polite"
        aria-atomic="true"
        data-notice-region=""
      >
        {current ? <span key={current.id}>{current.text}</span> : null}
      </div>
    </AnnouncerContext.Provider>
  );
}
