// Logic of the exit-with-parent.mjs preload (kept free of import side effects
// so it can be unit-tested).

export const PARENT_GONE_EXIT_CODE = 1;

export function exitWithParent(
  proc = process,
  exit = (code) => proc.exit(code),
) {
  if (!proc.connected) return false;
  // The channel must not keep an otherwise idle process alive.
  proc.channel?.unref?.();
  proc.on("disconnect", () => exit(PARENT_GONE_EXIT_CODE));
  return true;
}
