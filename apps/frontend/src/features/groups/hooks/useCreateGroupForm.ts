import { useRef, useState, type FormEvent } from "react";

import { useCreateGroup } from "./useGroups";

/** Form state of the create-group screen; the mutation itself lives in Query. */
export function useCreateGroupForm(
  organizationId: string,
  onCreated: (groupId: string) => void,
) {
  const create = useCreateGroup(organizationId);
  const [values, setValues] = useState({ name: "", description: "" });
  const [nameMissing, setNameMissing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const change = (field: "name" | "description", value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (field === "name") setNameMissing(false);
  };

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
    create.mutate(
      { name, ...(description ? { description } : {}) },
      { onSuccess: ({ group }) => onCreated(group.id) },
    );
  };

  return {
    create,
    values,
    change,
    nameInput,
    nameMessage: nameMissing ? "Ingresa el nombre del grupo." : "",
    submit,
  };
}
