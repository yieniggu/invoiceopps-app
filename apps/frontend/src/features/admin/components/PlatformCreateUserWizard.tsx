import { useRef } from "react";

import { LinkButton } from "../../../components/LinkButton";
import { paths } from "../../navigation/paths";
import {
  CreateUserWizard,
  type WizardSubmitter,
} from "../../users/components/CreateUserWizard";
import { usePresentIssuedCredential } from "../../users/components/IssuedCredentialProvider";
import { useSecretOutbox } from "../../users/hooks/useSecretOutbox";
import { useCreatePlatformUser } from "../../users/hooks/useUsers";
import { definedPasswordOf, toPlatformInput } from "../../users/wizard/draft";

/** Platform flow: the create-user wizard over every organization. */
export function PlatformCreateUserWizard({
  organizations,
  organizationsTotal,
  initialOrganizationId,
  initialOrganization,
}: {
  /** The first page of the platform's organizations. */
  organizations: Array<{ id: string; name: string; slug?: string }>;
  /** How many exist in all; the wizard searches the server for the rest. */
  organizationsTotal: number;
  initialOrganizationId?: string;
  initialOrganization?: { id: string; name: string; slug?: string };
}) {
  const present = usePresentIssuedCredential();
  const successFocus = useRef<HTMLButtonElement>(null);
  const outbox = useSecretOutbox();
  const create = useCreatePlatformUser(
    (credential) => present(credential, successFocus),
    outbox.read,
  );
  const submitter: WizardSubmitter = {
    isPending: create.isPending,
    error: create.error,
    reset: create.reset,
    submit: (draft, { onSuccess, onError }) => {
      // The defined password travels outside the mutation variables.
      outbox.stage(definedPasswordOf(draft));
      create.mutate(toPlatformInput(draft), {
        onSuccess: ({ name }) => onSuccess(name),
        onError,
        onSettled: outbox.clear,
      });
    },
  };
  return (
    <CreateUserWizard
      organizations={organizations}
      organizationsTotal={organizationsTotal}
      initialOrganizationId={initialOrganizationId}
      initialOrganization={initialOrganization}
      submitter={submitter}
      successFocusRef={successFocus}
      doneAction={
        <LinkButton to={paths.organizations} variant="secondary">
          Ir a organizaciones
        </LinkButton>
      }
    />
  );
}
