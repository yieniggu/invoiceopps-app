import { request, type APIRequestContext } from "@playwright/test";

import { BASE_URL } from "./env.ts";
import {
  ALL_FLAGS,
  E2E_PASSWORD,
  NO_FLAGS,
} from "../../backend/e2e/fixtures.ts";

export type Flags = typeof ALL_FLAGS;
export { ALL_FLAGS, NO_FLAGS };

/** The cookie Origin check of the backend needs the browser's own origin. */
const ORIGIN = { Origin: BASE_URL };

export async function newApiContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: ORIGIN });
}

/** Authenticated JSON client for building fixtures through the real API. */
export class Api {
  private constructor(private readonly context: APIRequestContext) {}

  static async signIn(credentials: { rut: string; password: string }) {
    const context = await newApiContext();
    const response = await context.post("/api/v1/auth/login", {
      data: credentials,
    });
    if (response.status() !== 200) {
      throw new Error(`API sign-in failed (${response.status()})`);
    }
    return new Api(context);
  }

  async call<T = unknown>(
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    data?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const response = await this.context[method](`/api/v1${path}`, {
      data,
      headers,
    });
    if (!response.ok()) {
      throw new Error(
        `${method.toUpperCase()} ${path} failed (${response.status()}): ${await response.text()}`,
      );
    }
    return (response.status() === 204 ? undefined : await response.json()) as T;
  }

  async dispose() {
    await this.context.dispose();
  }
}

/** Gives a freshly provisioned person the shared fixture password. */
export async function settlePassword(credentials: {
  rut: string;
  temporaryPassword: string;
}) {
  const api = await Api.signIn({
    rut: credentials.rut,
    password: credentials.temporaryPassword,
  });
  try {
    await api.call("post", "/auth/change-password", {
      currentPassword: credentials.temporaryPassword,
      newPassword: E2E_PASSWORD,
    });
  } finally {
    await api.dispose();
  }
}
