import { useEffect, useState } from "react";

/**
 * The current instant, refreshed at every multiple of `periodMs` of the clock
 * (every minute on the minute for 60_000), not every `periodMs` after mount:
 * a value shown from it is always the one a submit made in the same period
 * would compute. The timer is cleared when the component goes away.
 */
export function useNow(periodMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const current = Date.now();
      timer = setTimeout(
        () => {
          setNow(new Date());
          schedule();
        },
        periodMs - (current % periodMs),
      );
    };
    // The first render may be older than the period boundary just crossed.
    setNow(new Date());
    schedule();
    return () => clearTimeout(timer);
  }, [periodMs]);
  return now;
}
