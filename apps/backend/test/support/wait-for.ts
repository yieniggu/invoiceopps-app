/**
 * Resolves as soon as `condition` holds, polling a cheap in-process or
 * database check, and fails with `description` after a generous deadline. It
 * replaces fixed sleeps: a slow machine only waits longer, a fast one does not
 * wait at all, and the assertion that follows never races the event.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  { timeoutMs = 15_000, intervalMs = 5 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
