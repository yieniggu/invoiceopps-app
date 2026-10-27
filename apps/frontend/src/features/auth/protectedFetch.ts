// Central fetch for authenticated calls. A temporary password can become
// pending while the page is open (an administrator resets it), after which the
// server answers 403 ONBOARDING_REQUIRED to every protected route. Screens
// would show a generic permission message; instead the registered listener
// reloads the profile so the forced password-change screen appears.

let onboardingListener: (() => void) | undefined;

/** Registers the single listener; returns its unsubscribe function. */
export function onOnboardingRequired(listener: () => void) {
  onboardingListener = listener;
  return () => {
    if (onboardingListener === listener) onboardingListener = undefined;
  };
}

async function carriesOnboardingCode(response: Response) {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return body.error?.code === "ONBOARDING_REQUIRED";
  } catch {
    return false;
  }
}

export async function protectedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 403 && (await carriesOnboardingCode(response))) {
    onboardingListener?.();
  }
  return response;
}
