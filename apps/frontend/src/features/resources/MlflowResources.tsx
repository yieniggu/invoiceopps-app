import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";

export type MlflowContext = {
  organizationId: string;
  ownerType: "user" | "group";
  ownerId: string;
};

type Item = { url?: string };
type Snapshot = {
  experiment: (Item & { id: string; name: string }) | null;
  runs: Array<Item & { runId: string }>;
  registeredModel: (Item & { name: string }) | null;
  versions: Array<Item & { version: string; runId?: string }>;
  truncated: boolean;
  fetchedAt: string;
};

function ResourceLink({ url, children }: { url?: string; children: string }) {
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline"
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

export function MlflowResources({ context }: { context: MlflowContext }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const load = () => {
      if (!active || document.hidden || inFlight) return;
      inFlight = true;
      const requestGeneration = ++generation;
      controller = new AbortController();
      const query = new URLSearchParams(context);
      void fetch(`/mlflow/resources?${query}`, {
        credentials: "same-origin",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("MLflow read failed");
          return (await response.json()) as Snapshot;
        })
        .then((result) => {
          if (active && requestGeneration === generation) {
            setSnapshot(result);
            setError(false);
            setLoading(false);
          }
        })
        .catch(() => {
          if (active && requestGeneration === generation) {
            setError(true);
            setLoading(false);
          }
        })
        .finally(() => {
          if (requestGeneration === generation) {
            inFlight = false;
            if (active && !document.hidden) timer = setTimeout(load, 15_000);
          }
        });
    };
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        controller?.abort();
        generation += 1;
        inFlight = false;
      } else if (!inFlight) {
        clearTimeout(timer);
        load();
      }
    };
    refresh.current = () => {
      clearTimeout(timer);
      load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    load();
    return () => {
      active = false;
      generation += 1;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [context.organizationId, context.ownerType, context.ownerId]);

  return (
    <section
      aria-labelledby="mlflow-resources-title"
      className="space-y-3 rounded-md border border-slate-200 bg-white p-4"
    >
      <h3 id="mlflow-resources-title">Recursos de MLflow</h3>
      {loading && !snapshot ? <p>Cargando recursos de MLflow...</p> : null}
      {error ? (
        <p role="alert">
          {snapshot
            ? `No se pudo actualizar MLflow. Se muestran datos anteriores, consultados el ${new Date(snapshot.fetchedAt).toLocaleString("es-CL")}.`
            : "No fue posible consultar MLflow. Puedes reintentar."}
        </p>
      ) : null}
      {error ? (
        <Button type="button" onClick={() => refresh.current()}>
          Reintentar MLflow
        </Button>
      ) : null}
      {snapshot ? (
        <>
          <p className="text-sm text-slate-600">
            Última consulta exitosa:{" "}
            {new Date(snapshot.fetchedAt).toLocaleString("es-CL")}
          </p>
          {snapshot.truncated ? (
            <p>Vista parcial: existen más resultados en MLflow.</p>
          ) : null}
          <div>
            <h4>Experimento</h4>
            {snapshot.experiment ? (
              <ResourceLink url={snapshot.experiment.url}>
                {snapshot.experiment.name}
              </ResourceLink>
            ) : (
              <p>No hay experimento para este propietario.</p>
            )}
          </div>
          <div>
            <h4>Runs</h4>
            {snapshot.runs.length ? (
              <ul>
                {snapshot.runs.map((run) => (
                  <li key={run.runId}>
                    <ResourceLink url={run.url}>{run.runId}</ResourceLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No hay runs para este propietario.</p>
            )}
          </div>
          <div>
            <h4>Modelo registrado</h4>
            {snapshot.registeredModel ? (
              <ResourceLink url={snapshot.registeredModel.url}>
                {snapshot.registeredModel.name}
              </ResourceLink>
            ) : (
              <p>No hay modelo registrado para este propietario.</p>
            )}
          </div>
          <div>
            <h4>Versiones</h4>
            {snapshot.versions.length ? (
              <ul>
                {snapshot.versions.map((version) => (
                  <li key={version.version}>
                    <ResourceLink
                      url={version.url}
                    >{`Versión ${version.version}`}</ResourceLink>
                    {version.runId ? ` · Run ${version.runId}` : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No hay versiones para este propietario.</p>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
