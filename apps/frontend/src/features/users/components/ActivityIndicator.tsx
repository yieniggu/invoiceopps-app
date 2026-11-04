import { formatInstant } from "../../../lib/datetime";
import { describeActivity } from "../activity";

/**
 * Colored dot plus «Activo hace …»: the dot is decoration, the text carries
 * the state. `now` is the server's clock when the data was fetched (the
 * query's `serverNow`), so rendering stays pure and needs no timer.
 *
 * The exact instant follows the label: visible when `detailed` (profile
 * screens), otherwise only for assistive technology so table cells stay
 * short. There is no `title`: browsers expose it as the accessible
 * description, so screen readers would announce the instant twice.
 */
export function ActivityIndicator({
  lastActiveAt,
  now,
  detailed = false,
}: {
  lastActiveAt: string | null;
  now: number;
  detailed?: boolean;
}) {
  const { tone, label } = describeActivity(lastActiveAt, now);
  return (
    <span className={`activity-indicator is-${tone}`}>
      <span className="activity-dot" aria-hidden="true" />
      {lastActiveAt !== null && tone !== "never" ? (
        <time dateTime={lastActiveAt}>
          <span>{label}</span>
          <span className={detailed ? "activity-instant" : "visually-hidden"}>
            {` (${formatInstant(lastActiveAt)})`}
          </span>
        </time>
      ) : (
        label
      )}
    </span>
  );
}
