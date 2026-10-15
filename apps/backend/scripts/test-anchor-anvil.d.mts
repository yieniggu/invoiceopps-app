export function assertOwnedListener(
  output: string,
  pid: number,
  port: number,
): void;
export function formatSmokeFailure(details?: Record<string, unknown>): string;
export function reportSmokeFailure<T>(
  error: T,
  details?: Record<string, unknown>,
  output?: (marker: string) => void,
): T;
export function checkOwnedListener(pid: number, port: number): void;
export interface OwnedChildResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  spawnCode: string | undefined;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}
export function runOwnedChild(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes?: number;
  },
): Promise<OwnedChildResult>;
export interface OwnedChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed?: boolean;
  once(event: "exit" | "close", listener: () => void): this;
  removeListener(event: "exit" | "close", listener: () => void): this;
  kill(signal: NodeJS.Signals): boolean;
}
export function stopOwnedChild(child: OwnedChild): Promise<boolean>;
