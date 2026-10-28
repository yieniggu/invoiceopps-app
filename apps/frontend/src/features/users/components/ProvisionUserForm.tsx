import { useRef } from "react";

import { useProvisionUser } from "../hooks/useUsers";
import { useSecretOutbox } from "../hooks/useSecretOutbox";
import { definedPasswordOf, toOrganizationInput } from "../wizard/draft";
import { CreateUserWizard, type WizardSubmitter } from "./CreateUserWizard";
import { usePresentIssuedCredential } from "./IssuedCredentialProvider";

/**
 * Org ADMIN flow: the create-user wizard in single-organization mode. The
 * organization is fixed; the steps cover the person's data, their role and
 * permissions there, and the groups of that organization.
 */
export function ProvisionUserForm({
  organization,
  onCreated,
}: {
  organization: { id: string; name: string };
  /** Called with the new person's name once the user exists. */
  onCreated?: (name: string) => void;
}) {
  const present = usePresentIssuedCredential();
  const successFocus = useRef<HTMLButtonElement>(null);
  const outbox = useSecretOutbox();
  const provision = useProvisionUser(
    organization.id,
    (credential) => present(credential, successFocus),
    outbox.read,
  );
  const submitter: WizardSubmitter = {
    isPending: provision.isPending,
    error: provision.error,
    reset: provision.reset,
    submit: (draft, { onSuccess, onError }) => {
      // The defined password travels outside the mutation variables.
      outbox.stage(definedPasswordOf(draft));
      provision.mutate(toOrganizationInput(draft), {
        onSuccess: ({ name }) => {
          onSuccess(name);
          onCreated?.(name);
        },
        onError,
        onSettled: outbox.clear,
      });
    },
  };
  return (
    <CreateUserWizard
      organizations={[organization]}
      fixedOrganization={organization}
      submitter={submitter}
      successFocusRef={successFocus}
      title="Crear usuario nuevo"
      headingLevel={3}
    />
  );
}
