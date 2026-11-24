import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const RESET_AFTER_MS = 1500;

/** `9856bc10-…-1ca0ce06bc9e` → `9856bc…06bc9e`; the full value stays in the title. */
function truncate(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

/**
 * A shortened identifier with a copy icon that turns into a check once the
 * full value is in the clipboard.
 */
export function CopyableId({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), RESET_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Without clipboard access the full value is still in the title.
    }
  };

  return (
    <span className="copyable-id">
      <code title={value}>{truncate(value)}</code>
      <button
        type="button"
        className="copyable-id-button"
        aria-label={copied ? `${label} copiado` : `Copiar ${label}`}
        title={copied ? "Copiado" : "Copiar"}
        data-copied={copied}
        onClick={() => void copyValue()}
      >
        <Copy aria-hidden="true" size={16} className="copyable-id-icon" />
        <Check aria-hidden="true" size={16} className="copyable-id-icon" />
      </button>
    </span>
  );
}
