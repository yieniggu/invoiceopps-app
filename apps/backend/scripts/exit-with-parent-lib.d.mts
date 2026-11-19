export const PARENT_GONE_EXIT_CODE: number;
export function exitWithParent(
  proc?: NodeJS.Process,
  exit?: (code: number) => void,
): boolean;
