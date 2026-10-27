import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { useTheme, type ThemePreference } from "../lib/theme";

const options: {
  value: ThemePreference;
  /** Visible text (shown with `showLabels`, otherwise visually hidden). */
  label: string;
  /** Accessible name and tooltip; always contains the visible label. */
  title: string;
  icon: LucideIcon;
}[] = [
  { value: "light", label: "Claro", title: "Usar tema claro", icon: Sun },
  { value: "dark", label: "Oscuro", title: "Usar tema oscuro", icon: Moon },
  {
    value: null,
    label: "Sistema",
    title: "Usar preferencia del sistema",
    icon: Monitor,
  },
];

/**
 * Light / dark / system choice. Icon-only by default (the collapsed sidebar is
 * 4rem wide); `showLabels` adds visible text where there is room.
 */
export function ThemeToggle({ showLabels = false }: { showLabels?: boolean }) {
  const { preference, setPreference } = useTheme();
  return (
    <div role="group" aria-label="Tema" className="theme-toggle">
      {options.map(({ value, label, title, icon: Icon }) => (
        <button
          key={label}
          type="button"
          title={title}
          aria-label={title}
          aria-pressed={preference === value}
          onClick={() => setPreference(value)}
        >
          <Icon aria-hidden="true" focusable="false" size={18} />
          <span className={showLabels ? undefined : "visually-hidden"}>
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}
