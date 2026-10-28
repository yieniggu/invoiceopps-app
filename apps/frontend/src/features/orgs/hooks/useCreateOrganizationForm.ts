import { useRef, useState, type FormEvent } from "react";

import { isValidRut, toApiRut } from "../../../lib/rut";
import type { OrganizationFormValues } from "../components/OrganizationForm";
import { useCreateOrganization } from "./useOrganizations";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MESSAGE =
  "El identificador debe tener solo minúsculas, números y guiones (por ejemplo: instituto-sur).";
const EMPTY: OrganizationFormValues = {
  name: "",
  slug: "",
  description: "",
  firstAdminRut: "",
};

type Field = "name" | "slug";

/** Form state, validation and submission of the create-organization screen. */
export function useCreateOrganizationForm(
  onCreated: (created: { name: string; firstAdminRut: string }) => void,
) {
  const create = useCreateOrganization();
  const [values, setValues] = useState(EMPTY);
  const [submitted, setSubmitted] = useState(false);
  const [invalid, setInvalid] = useState<Field>();
  const nameInput = useRef<HTMLInputElement>(null);
  const slugInput = useRef<HTMLInputElement>(null);
  const rutInput = useRef<HTMLInputElement>(null);

  const change = (field: keyof OrganizationFormValues, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    setSubmitted(true);
    // The values are read here, before the request starts.
    const captured = {
      name: values.name.trim(),
      slug: values.slug,
      description: values.description.trim(),
      rut: values.firstAdminRut,
    };
    if (!captured.name) {
      setInvalid("name");
      nameInput.current?.focus();
      return;
    }
    if (!SLUG.test(captured.slug)) {
      setInvalid("slug");
      slugInput.current?.focus();
      return;
    }
    setInvalid(undefined);
    if (!isValidRut(captured.rut)) {
      rutInput.current?.focus();
      return;
    }
    const firstAdminRut = toApiRut(captured.rut);
    create.mutate(
      {
        name: captured.name,
        slug: captured.slug,
        ...(captured.description ? { description: captured.description } : {}),
        firstAdminRut,
      },
      { onSuccess: () => onCreated({ name: captured.name, firstAdminRut }) },
    );
  };

  return {
    create,
    values,
    change,
    submit,
    submitted,
    invalid,
    nameMessage:
      invalid === "name" ? "Ingresa el nombre de la organización." : "",
    slugMessage: invalid === "slug" ? SLUG_MESSAGE : "",
    refs: { nameInput, slugInput, rutInput },
  };
}
