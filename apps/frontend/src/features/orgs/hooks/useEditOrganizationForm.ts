import { useRef, useState, type FormEvent } from "react";

import type { OrganizationFormValues } from "../components/OrganizationForm";
import type { UpdateOrganizationInput } from "../types";
import { useUpdateOrganization } from "./useOrganizations";

/** Draft, validation and submission of the edit-organization screen. */
export function useEditOrganizationForm(
  organization: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
  },
  onSaved: (changed: boolean) => void,
) {
  const update = useUpdateOrganization(organization.id);
  const [values, setValues] = useState<OrganizationFormValues>({
    name: organization.name,
    slug: organization.slug,
    description: organization.description ?? "",
    firstAdminRut: "",
  });
  const [nameMissing, setNameMissing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const change = (field: keyof OrganizationFormValues, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (update.isPending) return;
    // Read before the request starts.
    const name = values.name.trim();
    const description = values.description.trim();
    if (!name) {
      setNameMissing(true);
      nameInput.current?.focus();
      return;
    }
    setNameMissing(false);
    const input: UpdateOrganizationInput = {};
    if (name !== organization.name) input.name = name;
    if (description !== (organization.description ?? ""))
      input.description = description === "" ? null : description;
    if (Object.keys(input).length === 0) {
      onSaved(false);
      return;
    }
    update.mutate(input, { onSuccess: () => onSaved(true) });
  };

  return {
    update,
    values,
    change,
    submit,
    nameMessage: nameMissing ? "Ingresa el nombre de la organización." : "",
    invalid: nameMissing ? ("name" as const) : undefined,
    nameInput,
  };
}
