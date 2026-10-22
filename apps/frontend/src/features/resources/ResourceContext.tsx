import { useCallback, useEffect, useState } from "react";

import { Button } from "./Button";
import { MlflowResources, type MlflowContext } from "./MlflowResources";
import { referenceType } from "./mlflowPresentation";
import { contextValue, useWorkspace } from "../workspace/WorkspaceContext";
import { useUnauthorized } from "../auth/ProtectedSession";
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

type Resource = {
  id: string;
  type: string;
  label: string;
};

type ResourcesState =
  | { kind: "loading" }
  | { kind: "error"; status?: number }
  | { kind: "loaded"; resources: Resource[] };

export function ResourceContext({
  profile,
  groups,
}: {
  profile: Profile;
  groups: Group[];
}) {
  const {
    contexts,
    selectedValue,
    setSelectedValue,
    selectedContext,
    ownerSelectorRef,
  } = useWorkspace(profile, groups);
  const unauthorized = useUnauthorized();
  const [expired, setExpired] = useState(false);
  const expire = useCallback(() => {
    setExpired(true);
    unauthorized();
  }, [unauthorized]);
  if (expired)
    return <p role="alert">La sesión expiró. Inicia sesión nuevamente.</p>;

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
      className="workspace-content space-y-4 border-slate-200 bg-slate-50/70"
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
          ref={ownerSelectorRef}
          className="w-full border-slate-300 bg-white text-slate-900 sm:max-w-md"
          value={selectedValue}
          onChange={(event) => setSelectedValue(event.target.value)}
        >
          <option value="" disabled>
            Selecciona un propietario
          </option>
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
      {selectedContext ? (
        <ResourceReferences
          key={`references:${selectedValue}`}
          context={selectedContext}
          onUnauthorized={expire}
        />
      ) : (
        <p>Selecciona un propietario autorizado para consultar recursos.</p>
      )}
      {selectedContext ? (
        <MlflowResources
          onUnauthorized={expire}
          key={selectedValue}
          context={{
            organizationId: selectedContext.organizationId,
            ownerType: selectedContext.ownerType,
            ownerId: selectedContext.ownerId,
          }}
        />
      ) : null}
    </section>
  );
}

function ResourceReferences({
  context,
  onUnauthorized,
}: {
  context: MlflowContext;
  onUnauthorized: () => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<ResourcesState>({ kind: "loading" });
  const { organizationId, ownerType, ownerId } = context;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ kind: "loading" });
    const query = new URLSearchParams({ organizationId, ownerType, ownerId });
    void fetch(`/resources?${query}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          active = false;
          onUnauthorized();
          return;
        }
        if (!response.ok) {
          setState({ kind: "error", status: response.status });
          return;
        }
        const result = (await response.json()) as { resources: Resource[] };
        if (active) setState({ kind: "loaded", resources: result.resources });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [organizationId, ownerType, ownerId, reloadKey, onUnauthorized]);
  return (
    <section aria-labelledby="resource-references-title">
      <h3 id="resource-references-title">Referencias de navegación</h3>
      <p>
        Fuente: referencias registradas en InvoiceOps. Son solo metadatos de
        navegación, no artefactos copiados, entrenamientos ni confirmación de
        disponibilidad en MLflow. La API no proporciona enlaces para estas
        referencias.
      </p>
      {state.kind === "loading" ? (
        <p role="status">Cargando recursos...</p>
      ) : null}
      {state.kind === "error" ? (
        <>
          <p role="alert">
            <span>No fue posible cargar los recursos.</span>{" "}
            {state.status === 403 || state.status === 404 ? (
              <span>
                {state.status === 403
                  ? "No tienes acceso a las referencias de este contexto."
                  : "Las referencias no están disponibles para este contexto."}
              </span>
            ) : null}
          </p>
          <Button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Reintentar recursos
          </Button>
        </>
      ) : null}
      {state.kind === "loaded" ? (
        state.resources.length ? (
          <ul className="card-list">
            {state.resources.map((resource) => (
              <li key={resource.id} className="context-card">
                <strong>{resource.label}</strong>
                <span>{referenceType(resource.type)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No hay recursos para este propietario.</p>
        )
      ) : null}
    </section>
  );
}
