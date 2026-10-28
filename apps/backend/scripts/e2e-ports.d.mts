export const defaultDevelopmentPorts: number[];

export function developmentPorts(
  env?: Record<string, string | undefined>,
): Set<number>;

export function e2ePort(
  name: string,
  fallback: number,
  env?: Record<string, string | undefined>,
): number;
