export function isAcceptingConnections(
  port: number,
  timeoutMs?: number,
): Promise<boolean>;

export function listPortHolders(
  port: number,
  run?: (command: string, args: string[]) => Promise<string> | string,
): Promise<string[]>;

export function portInUseMessage(
  port: number,
  code: string,
  pids: string[],
): string;

export function assertPortFree(
  port: number,
  options?: { listHolders?: (port: number) => Promise<string[]> },
): Promise<void>;
