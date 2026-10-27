import { useRef, useState, type FormEvent } from "react";

import { isSetupComplete, type GroupSetup } from "../api/groupSetup";
import { useOrgUsersQuery } from "../../users/hooks/useUsers";
import type { GroupPermissions } from "../types";
import { hasAnyPermission, NO_PERMISSIONS } from "../types/permissions";
import { useCreateGroupFlow } from "./useGroups";

/** Form state of the create-group screen; the flow itself lives in Query. */
export function useCreateGroupForm(
  organizationId: string,
  onCreated: (result: {
    groupId: string;
    name: string;
    /** What still needs a retry; undefined when everything was applied. */
    failed: GroupSetup | undefined;
  }) => void,
) {
  const create = useCreateGroupFlow(organizationId);
  const users = useOrgUsersQuery(organizationId);
  const [values, setValues] = useState({ name: "", description: "" });
  const [permissions, setPermissions] =
    useState<GroupPermissions>(NO_PERMISSIONS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [nameMissing, setNameMissing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const change = (field: "name" | "description", value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (field === "name") setNameMissing(false);
  };
  const toggleMember = (userId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    // The values are captured now; typing during the request cannot change them.
    const name = values.name.trim();
    const description = values.description.trim();
    setNameMissing(!name);
    if (!name) {
      nameInput.current?.focus();
      return;
    }
    const members = (users.data ?? [])
      .filter(({ id }) => selected.has(id))
      .map(({ id, name: memberName }) => ({ userId: id, name: memberName }));
    create.mutate(
      {
        group: { name, ...(description ? { description } : {}) },
        setup: {
          ...(hasAnyPermission(permissions)
            ? { permissions: { ...permissions } }
            : {}),
          members,
        },
      },
      {
        onSuccess: ({ groupId, failed }) =>
          onCreated({
            groupId,
            name,
            failed: isSetupComplete(failed) ? undefined : failed,
          }),
      },
    );
  };

  return {
    create,
    users,
    values,
    change,
    permissions,
    setPermissions,
    selected,
    toggleMember,
    nameInput,
    nameMessage: nameMissing ? "Ingresa el nombre del grupo." : "",
    submit,
  };
}
