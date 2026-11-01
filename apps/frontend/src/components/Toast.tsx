import { CircleCheck, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type HTMLAttributes } from "react";

import { useAnnouncer } from "./NoticeRegion";

const MIN_VISIBLE_MS = 6000;
/** Reading time per character, so a long message outlasts the minimum. */
const MS_PER_CHARACTER = 60;

/** How long a message stays: at least 6 s, longer for a long text. */
export const toastDuration = (message: string) =>
  Math.max(MIN_VISIBLE_MS, MS_PER_CHARACTER * message.length);

/** After closing the card, focus must land somewhere: the page title or main. */
function restoreFocus() {
  const target =
    document.getElementById("page-title") ??
    document.querySelector<HTMLElement>("main");
  target?.focus();
}

/**
 * Floating notice (bottom right; full width at the bottom on narrow screens),
 * success by default or `warning` for something to act on. Inside the app shell the text is announced through the shell's
 * persistent live region (see `NoticeRegionProvider`) and the card itself is
 * not live, so nothing is announced twice. Without a shell (a bare render) the
 * wrapper is its own polite region, always mounted with only its content
 * changing. The card closes itself after a length-aware time and waits while
 * the pointer or keyboard focus is on it.
 *
 * `noticeId` identifies one arrival of a notice (see `useRouteNotice`): a
 * dismissal is remembered for that arrival, not for the text, so the same
 * message arriving again shows again. Without it the text is the identity.
 */
export function Toast({
  message,
  noticeId,
  tone = "success",
  persistent = false,
}: {
  message: string | undefined;
  noticeId?: string;
  /** `warning` is for something the person should act on, not just a result. */
  tone?: "success" | "warning";
  /**
   * Stays until dismissed instead of timing out. A persistent notice flows in
   * the page (where it is rendered) rather than floating over it, so it can
   * never cover what is at the bottom of the screen, such as the paginator.
   */
  persistent?: boolean;
}) {
  const instance = noticeId ?? message;
  const announcer = useAnnouncer();
  const [dismissed, setDismissed] = useState<string>();
  const [paused, setPaused] = useState(false);
  const visible = message !== undefined && dismissed !== instance;
  const hovered = useRef(false);
  const focused = useRef(false);
  const sync = () => setPaused(hovered.current || focused.current);
  const dismiss = (restore: boolean) => {
    // The unmounting card sends no leave/blur: clear the pause by hand.
    hovered.current = false;
    focused.current = false;
    setPaused(false);
    setDismissed(instance);
    // Closing with the button removes the focused element: keep focus alive.
    if (restore) restoreFocus();
  };

  useEffect(() => {
    if (!visible || paused || persistent || message === undefined) return;
    const timer = window.setTimeout(
      () => dismiss(false),
      toastDuration(message),
    );
    return () => window.clearTimeout(timer);
    // `dismiss` only reads the refs and `instance`, which `message` and
    // `noticeId` already cover.
  }, [visible, paused, persistent, message, instance]);

  // Written after mount, into a region that already exists (empty).
  useEffect(() => {
    if (!announcer || !visible || message === undefined) return;
    announcer.announce(instance ?? message, message);
    return () => announcer.clear(instance ?? message);
  }, [announcer, visible, message, instance]);

  const Icon = tone === "warning" ? TriangleAlert : CircleCheck;
  const ownRegion: HTMLAttributes<HTMLDivElement> = announcer
    ? {}
    : { role: "status", "aria-live": "polite", "aria-atomic": true };

  return (
    <div
      className={persistent ? "toast-region is-inline" : "toast-region"}
      {...ownRegion}
      onMouseEnter={() => {
        hovered.current = true;
        sync();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        sync();
      }}
      onFocus={() => {
        focused.current = true;
        sync();
      }}
      onBlur={() => {
        focused.current = false;
        sync();
      }}
    >
      {visible ? (
        <div className={tone === "warning" ? "toast is-warning" : "toast"}>
          <Icon
            className="toast-icon"
            aria-hidden="true"
            focusable="false"
            size={22}
          />
          <p className="toast-message">{message}</p>
          <button
            type="button"
            className="icon-button toast-close"
            aria-label="Cerrar aviso"
            onClick={() => dismiss(true)}
          >
            <X aria-hidden="true" focusable="false" size={18} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
