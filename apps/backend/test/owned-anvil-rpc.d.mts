export interface OwnedAnvilRpc {
  request(method: string, params?: readonly unknown[]): Promise<unknown>;
  getRequestCount(): number;
  getLastMethod(): string;
}

export function createOwnedAnvilRpc(options: {
  pid: number;
  port: number;
  assertOwner(pid: number, port: number): void;
  fetchResponse: typeof fetch;
}): OwnedAnvilRpc;
