import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { useUnauthorized } from "../auth/ProtectedSession";
import { ResourceLink, snapshotDate } from "./mlflowPresentation";

export type MlflowContext = {
  organizationId: string;
  ownerType: "user" | "group";
  ownerId: string;
};

type Item = { url?: string | null };
type Snapshot = {
  experiment: (Item & { id: string; name: string }) | null;
  runs: Array<Item & { runId: string }>;
  registeredModel: (Item & { name: string }) | null;
  versions: Array<Item & { version: string; runId?: string }>;
  truncated: boolean;
  fetchedAt: string;
};

export function MlflowResources({
  context,
  onUnauthorized,
}: {
  context: MlflowContext;
  onUnauthorized?: () => void;
}) {
  return (
    <MlflowSnapshot
      key={JSON.stringify([
        context.organizationId,
        context.ownerType,
        context.ownerId,
      ])}
      context={context}
      onUnauthorized={onUnauthorized}
    />
  );
}

function MlflowSnapshot({
  context,
  onUnauthorized,
}: {
  context: MlflowContext;
  onUnauthorized?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<
    "unavailable" | "forbidden" | "missing" | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const sessionUnauthorized = useUnauthorized();
  const unauthorized = onUnauthorized ?? sessionUnauthorized;
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const stop = () => {
      active = false;
      generation += 1;
      clearTimeout(timer);
      controller?.abort();
      refresh.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
    };
    const load = () => {
      if (!active || document.hidden || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      setLoading(true);
      const requestGeneration = ++generation;
      controller = new AbortController();
      const query = new URLSearchParams(context);
      void fetch(`/mlflow/resources?${query}`, {
        credentials: "same-origin",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!active || requestGeneration !== generation) return null;
          if (response.status === 401) {
            stop();
            setSnapshot(null);
            setLoading(false);
            setExpired(true);
            unauthorized();
            return null;
          }
          if (response.status === 403 || response.status === 404) {
            setSnapshot(null);
            setError(response.status === 403 ? "forbidden" : "missing");
            return null;
          }
          if (!response.ok) throw new Error("MLflow read failed");
          return (await response.json()) as Snapshot;
        })
        .then((result) => {
          if (result && active && requestGeneration === generation) {
            setSnapshot(result);
            setError(null);
          }
        })
        .catch(() => {
          if (active && requestGeneration === generation) {
            setError("unavailable");
          }
        })
        .finally(() => {
          if (active && requestGeneration === generation) {
            inFlight = false;
            setLoading(false);
            if (!document.hidden) timer = setTimeout(load, 15_000);
          }
        });
    };
    const onVisibility = () => {
      if (!active) return;
      setHidden(document.hidden);
      if (document.hidden) {
        clearTimeout(timer);
        controller?.abort();
        generation += 1;
        inFlight = false;
        setLoading(false);
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
    return stop;
  }, [
    context.organizationId,
    context.ownerType,
    context.ownerId,
    unauthorized,
  ]);

  if (expired)
    return <p role="alert">La sesión expiró. Inicia sesión nuevamente.</p>;

  return (
    <section
      aria-labelledby="mlflow-resources-title"
      className="space-y-3 rounded-md border border-slate-200 bg-white p-4"
    >
      <h3 id="mlflow-resources-title">Recursos de MLflow</h3>
      <p>
        Fuente: MLflow · Solo lectura. Consulta de metadatos; no copia
        artefactos ni entrena modelos.
      </p>
      <p>
        Actualización automática cada 15 segundos mientras esta vista está
        visible. Actualizar solo vuelve a consultar estos metadatos; no recarga
        el modelo servido ni modifica aliases.
      </p>
      <div className="action-row">
        <Button
          type="button"
          disabled={loading || hidden}
          onClick={() => refresh.current()}
        >
          {error ? "Reintentar MLflow" : "Actualizar MLflow"}
        </Button>
        <p role="status">
          {hidden
            ? "Actualización pausada: vista oculta."
            : loading
              ? snapshot
                ? "Actualizando metadatos de MLflow..."
                : "Cargando recursos de MLflow..."
              : error
                ? "Consulta de MLflow no disponible."
                : "Metadatos de MLflow consultados."}
        </p>
      </div>
      {error ? (
        <p role="alert">
          {error === "forbidden"
            ? "No tienes acceso a los recursos de MLflow de este contexto."
            : error === "missing"
              ? "Los recursos de MLflow no están disponibles para este contexto."
              : snapshot
                ? `No se pudo actualizar MLflow. Se muestran datos anteriores, consultados el ${snapshotDate(snapshot.fetchedAt)}.`
                : "No fue posible consultar MLflow. Puedes reintentar."}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <p className="text-sm text-slate-600">
            Última consulta exitosa:{" "}
            <span>{snapshotDate(snapshot.fetchedAt)}</span>
          </p>
          {snapshot.truncated ? (
            <p>
              Vista parcial: existen más resultados en MLflow. La consulta está
              limitada a 25 ejecuciones y 25 versiones; no se expone el total ni
              navegación a otras páginas.
            </p>
          ) : null}
          <div>
            <h4>Experimento</h4>
            {snapshot.experiment ? (
              <dl className="context-details">
                <div>
                  <dt>Nombre</dt>
                  <dd>
                    <ResourceLink url={snapshot.experiment.url}>
                      {snapshot.experiment.name}
                    </ResourceLink>
                  </dd>
                </div>
                <div>
                  <dt>Identificador del experimento</dt>
                  <dd>{snapshot.experiment.id}</dd>
                </div>
              </dl>
            ) : (
              <p>No hay experimento para este propietario.</p>
            )}
          </div>
          <div>
            <h4>Ejecuciones</h4>
            {snapshot.runs.length ? (
              <ul className="card-list" aria-label="Ejecuciones de MLflow">
                {snapshot.runs.map((run) => (
                  <li key={run.runId} className="context-card">
                    <p>Identificador de ejecución</p>
                    <ResourceLink url={run.url}>{run.runId}</ResourceLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No hay ejecuciones para este propietario.</p>
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
              <ul className="card-list" aria-label="Versiones del modelo">
                {snapshot.versions.map((version) => (
                  <li key={version.version} className="context-card">
                    <ResourceLink
                      url={version.url}
                    >{`Versión ${version.version}`}</ResourceLink>
                    <p>
                      {version.runId
                        ? `Ejecución de origen verificada: ${version.runId}`
                        : "Ejecución de origen no disponible en esta consulta."}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No hay versiones para este propietario.</p>
            )}
          </div>
          <p>
            La API actual no expone aliases, estados de ejecución, métricas,
            parámetros ni etiquetas. Su ausencia en esta vista no indica que no
            existan en MLflow.
          </p>
        </>
      ) : null}
    </section>
  );
}
