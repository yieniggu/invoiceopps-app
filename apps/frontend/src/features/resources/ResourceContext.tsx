import { useEffect, useState } from "react";

import { Button } from "./Button";
import "./tailwind.css";

type Profile = {
  id: string;
  memberships: Array<{
    organization: { id: string; name: string };
    role: string;
  }>;
};

type Group = {
  id: string;
  name: string;
  organization: { id: string; name: string };
};

type OwnerContext = {
  organizationId: string;
  organizationName: string;
  ownerType: "user" | "group";
  ownerId: string;
  ownerName: string;
};

type Resource = {
  id: string;
  type: string;
  label: string;
};

type ResourcesState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; resources: Resource[] };

function availableContexts(profile: Profile, groups: Group[]): OwnerContext[] {
  const individualContexts = profile.memberships.map(({ organization }) => ({
    organizationId: organization.id,
    organizationName: organization.name,
    ownerType: "user" as const,
    ownerId: profile.id,
    ownerName: "Trabajo individual",
  }));
  const groupContexts = groups.map((group) => ({
    organizationId: group.organization.id,
    organizationName: group.organization.name,
    ownerType: "group" as const,
    ownerId: group.id,
    ownerName: group.name,
  }));

  return [...individualContexts, ...groupContexts];
}

function contextValue(context: OwnerContext) {
  return `${context.ownerType}:${context.ownerId}:${context.organizationId}`;
}

export function ResourceContext({
  profile,
  groups,
}: {
  profile: Profile;
  groups: Group[];
}) {
  const contexts = availableContexts(profile, groups);
  const [selectedValue, setSelectedValue] = useState(() =>
    contexts[0] ? contextValue(contexts[0]) : "",
  );
  const [reloadKey, setReloadKey] = useState(0);
  const selectedContext = contexts.find(
    (context) => contextValue(context) === selectedValue,
  );
  const [state, setState] = useState<ResourcesState>({ kind: "loading" });

  useEffect(() => {
    if (!selectedContext) {
      setState({ kind: "loaded", resources: [] });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });
    const query = new URLSearchParams({
      organizationId: selectedContext.organizationId,
      ownerType: selectedContext.ownerType,
      ownerId: selectedContext.ownerId,
    });

    void fetch(`/resources?${query}`, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Resource request failed");
        }

        return (await response.json()) as { resources: Resource[] };
      })
      .then(({ resources }) => {
        if (!cancelled) {
          setState({ kind: "loaded", resources });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ kind: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey, selectedValue]);

  if (contexts.length === 0) {
    return (
      <section aria-labelledby="resources-title">
        <h2 id="resources-title">Recursos</h2>
        <p>No tienes organizaciones para consultar recursos.</p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="resources-title"
      className="space-y-4 border-slate-200 bg-slate-50/70"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 id="resources-title">Recursos</h2>
        {selectedContext ? (
          <p className="text-sm font-medium text-slate-600">
            {selectedContext.organizationName} ·{" "}
            {selectedContext.ownerType === "user"
              ? "Trabajo individual"
              : `Grupo: ${selectedContext.ownerName}`}
          </p>
        ) : null}
      </div>
      <label>
        Propietario
        <select
          className="w-full border-slate-300 bg-white text-slate-900 sm:max-w-md"
          value={selectedValue}
          onChange={(event) => setSelectedValue(event.target.value)}
        >
          {contexts.map((context) => (
            <option key={contextValue(context)} value={contextValue(context)}>
              {context.organizationName} ·{" "}
              {context.ownerType === "user"
                ? "Individual"
                : `Grupo: ${context.ownerName}`}
            </option>
          ))}
        </select>
      </label>
      {state.kind === "loading" ? (
        <p role="status">Cargando recursos...</p>
      ) : null}
      {state.kind === "error" ? (
        <>
          <p role="alert">No fue posible cargar los recursos.</p>
          <Button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Reintentar recursos
          </Button>
        </>
      ) : null}
      {state.kind === "loaded" && state.resources.length === 0 ? (
        <p>No hay recursos para este propietario.</p>
      ) : null}
      {state.kind === "loaded" && state.resources.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {state.resources.map((resource) => (
            <li
              key={resource.id}
              className="rounded-md border border-slate-200 bg-white px-3 py-2"
            >
              <strong className="block text-slate-950">{resource.label}</strong>{" "}
              <span className="text-sm text-slate-600">({resource.type})</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
