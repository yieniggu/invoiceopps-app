type Listener = (event: { matches: boolean; media: string }) => void;

/**
 * Installs a controllable `window.matchMedia` (jsdom has none). Only the
 * dark-scheme query is stateful; any other query reports `matches: false`.
 */
export function installMatchMedia(initialDark: boolean) {
  const original = window.matchMedia;
  const listeners = new Set<Listener>();
  let dark = initialDark;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("prefers-color-scheme: dark") ? dark : false;
    },
    media: query,
    addEventListener: (_: string, listener: Listener) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) =>
      listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return {
    listenerCount: () => listeners.size,
    setDark(next: boolean) {
      dark = next;
      listeners.forEach((listener) =>
        listener({ matches: next, media: "(prefers-color-scheme: dark)" }),
      );
    },
    restore() {
      if (original) window.matchMedia = original;
      else Reflect.deleteProperty(window, "matchMedia");
    },
  };
}
