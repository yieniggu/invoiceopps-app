import { toApiRut } from "../../../lib/rut";
import type { Profile } from "../types";
import { readApiError } from "./apiError";
import { protectedFetch } from "./protectedFetch";

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function requestProfile(): Promise<Profile> {
  // No AbortSignal on purpose: a retired session ignores late answers through
  // the session store, and the request shape is part of the transport contract.
  const response = await protectedFetch("/api/v1/auth/profile", {
    credentials: "same-origin",
  });
  if (!response.ok) throw await readApiError(response);
  return ((await response.json()) as { profile: Profile }).profile;
}

export async function requestLogin(credentials: {
  rut: string;
  password: string;
}) {
  const response = await fetch("/api/v1/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      rut: toApiRut(credentials.rut),
      password: credentials.password,
    }),
  });
  if (response.status !== 200) throw await readApiError(response);
}

export async function requestChangePassword(passwords: {
  currentPassword: string;
  newPassword: string;
}) {
  const response = await protectedFetch("/api/v1/auth/change-password", {
    method: "POST",
    credentials: "same-origin",
    headers: JSON_HEADERS,
    body: JSON.stringify(passwords),
  });
  if (!response.ok) throw await readApiError(response);
}

export async function requestLogout() {
  const response = await protectedFetch("/api/v1/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!response.ok) throw await readApiError(response);
}
