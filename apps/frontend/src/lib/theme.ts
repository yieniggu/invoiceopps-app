import { useEffect, useSyncExternalStore } from "react";

/** Appearance is a per-browser preference: not remote state, not per identity. */
export const THEME_STORAGE_KEY = "invoiceops.theme";

export type Theme = "light" | "dark";
/** `null` means "follow the system preference". */
export type ThemePreference = Theme | null;

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(
  stored: ThemePreference,
  systemPrefersDark: boolean,
): Theme {
  if (stored) return stored;
  return systemPrefersDark ? "dark" : "light";
}

export function readStoredTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredTheme(value: ThemePreference) {
  try {
    if (value) window.localStorage.setItem(THEME_STORAGE_KEY, value);
    else window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage may be blocked; the choice then only lasts for this page.
  }
}

// `storage` events never fire in the tab that wrote, so same-tab writes
// notify the subscribers directly. When storage is blocked the in-memory
// override keeps the control working for the current page.
const localListeners = new Set<() => void>();
let memoryPreference: { value: ThemePreference } | null = null;

/**
 * TEST ONLY: drops the in-memory override kept when storage is blocked, so it
 * cannot leak between tests. Never call it from production code.
 */
export function resetThemeForTests() {
  memoryPreference = null;
}

function notifyLocal() {
  localListeners.forEach((listener) => listener());
}

function subscribePreference(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) {
      memoryPreference = null;
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  localListeners.add(onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    localListeners.delete(onChange);
  };
}

function getPreference(): ThemePreference {
  return memoryPreference ? memoryPreference.value : readStoredTheme();
}

export function setThemePreference(value: ThemePreference) {
  writeStoredTheme(value);
  // Keep what the person chose even if the write was refused.
  memoryPreference = readStoredTheme() === value ? null : { value };
  notifyLocal();
}

function subscribeSystem(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSystemPrefersDark() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_QUERY).matches
  );
}

/**
 * Reflects the stored preference and the system scheme onto `<html
 * data-theme>`. Both inputs live outside React (localStorage / matchMedia), so
 * they are read with useSyncExternalStore and the attribute is synchronised in
 * an effect. Nothing here is fetched data: no React Query involved.
 */
export function useTheme() {
  const preference = useSyncExternalStore(
    subscribePreference,
    getPreference,
    () => null,
  );
  const systemPrefersDark = useSyncExternalStore(
    subscribeSystem,
    getSystemPrefersDark,
    () => false,
  );
  const theme = resolveTheme(preference, systemPrefersDark);

  // External sync: the attribute lives on <html>, outside the React tree.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return { preference, theme, setPreference: setThemePreference };
}
