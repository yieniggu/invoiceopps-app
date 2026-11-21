import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Boxes,
  ExternalLink,
  History,
  RefreshCw,
  ServerOff,
} from "lucide-react";

import { EmptyState } from "../../../components/EmptyState";
import { LiveStatus } from "../../../components/LiveStatus";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { DeploymentList } from "../components/DeploymentList";
import { GateReportView } from "../components/GateReportView";
import { ModelCatalog } from "../components/ModelCatalog";
import {
  describeModelsFailure,
  describeMetrics,
  IS_LIVE,
  type DeployBlock,
} from "../gateReasons";
import {
  useDeployModel,
  useDeployments,
  useModelCatalog,
  useRemoveDeployment,
  useSetInference,
} from "../hooks/useModels";
import {
  modelsContextOptions,
  selectedModelsContext,
  type ModelsContextOption,
} from "../modelsContexts";
import type { Deployment } from "../types";

/**
 * «Modelos»: registered models of a context, their deployments and the switch
 * for scoring new invoices. Only organizations with the section turned on
 * offer a context; anyone else gets the same page as for an unknown URL (the
 * profile is refreshed when a read answers 403/404, so turning the section off
 * elsewhere lands here too). A model-service outage stays inside this screen.
 */
export function ModelsScreen({ profile }: { profile: Profile }) {
  const [params, setParams] = useSearchParams();
  const options = modelsContextOptions(profile);
  const selected = selectedModelsContext(options, params);
  if (!selected) return <NotFoundScreen />;
  return (
    <div className="screen-stack">
      <PageHeader title="Modelos" />
      {options.length > 1 ? (
        <div className="form-field">
          <label htmlFor="models-context">Contexto</label>
          <select
            id="models-context"
            value={selected.value}
            onChange={(event) => {
              const next = options.find(
                ({ value }) => value === event.target.value,
              );
              if (!next) return;
              const query = new URLSearchParams({
                organizationId: next.organizationId,
              });
              if (next.groupId) query.set("groupId", next.groupId);
              setParams(query);
            }}
          >
            {options.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="muted">{selected.label}</p>
      )}
      {/* The key restarts every draft and result when the context changes. */}
      <ModelsContextView key={selected.value} option={selected} />
    </div>
  );
}

function ModelsContextView({ option }: { option: ModelsContextOption }) {
  const context = {
    organizationId: option.organizationId,
    groupId: option.groupId,
  };
  const catalog = useModelCatalog(context);
  const {
    query: deployments,
    stalled,
    polling,
    refresh,
  } = useDeployments(context);
  const deploy = useDeployModel(context);
  const inference = useSetInference(context);
  const remove = useRemoveDeployment(context);
  const [announcement, setAnnouncement] = useState({ pending: "", done: "" });
  const deploymentsTitle = useRef<HTMLHeadingElement>(null);

  // What is in flight is derived from each mutation's own state, never from
  // `mutate` callbacks (those are dropped when a mutation is reset), and every
  // model control is locked while any of the three runs, so a pending
  // mutation is never reset and two writes never overlap.
  const busy = deploy.isPending || inference.isPending || remove.isPending;
  const deployingKey = deploy.isPending
    ? `${deploy.variables.registeredModel}@${deploy.variables.version}`
    : undefined;
  const busyId = inference.isPending
    ? inference.variables.deploymentId
    : remove.isPending
      ? remove.variables
      : undefined;
  const busyKind = inference.isPending
    ? ("toggle" as const)
    : remove.isPending
      ? ("remove" as const)
      : undefined;

  const list = deployments.data;
  const live = new Map<string, Deployment>();
  for (const item of list?.items ?? [])
    if (IS_LIVE.has(item.status))
      live.set(`${item.registeredModel}@${item.version}`, item);
  const atCap = list ? list.limits.activeCount >= list.limits.maxActive : false;

  const blocked = (model: string, version: string): DeployBlock | undefined => {
    if (!list) return { kind: "loading" };
    if (live.has(`${model}@${version}`)) return { kind: "live" };
    if (list.limits.activeCount >= list.limits.maxActive)
      return { kind: "cap", max: list.limits.maxActive };
    return undefined;
  };

  // One result or error surface: every action starts from a clean slate.
  const resetAll = () => {
    deploy.reset();
    inference.reset();
    remove.reset();
  };
  // After a success the control may be gone or changed: focus lands on the
  // list's heading, where the outcome shows.
  const focusDeployments = () => deploymentsTitle.current?.focus();

  const startDeploy = (model: string, version: string) => {
    if (busy) return;
    resetAll();
    setAnnouncement({
      pending: `Desplegando ${model} versión ${version}`,
      done: "",
    });
    deploy.mutate(
      { ...context, registeredModel: model, version },
      { onSuccess: focusDeployments },
    );
  };

  const toggle = (deployment: Deployment, enabled: boolean) => {
    if (busy) return;
    resetAll();
    const name = `${deployment.registeredModel} versión ${deployment.version}`;
    setAnnouncement({
      pending: `Cambiando inferencia de ${name}`,
      done: `Inferencia ${enabled ? "activada" : "desactivada"}: ${name}`,
    });
    inference.mutate({ deploymentId: deployment.id, enabled });
  };

  const quit = (deployment: Deployment) => {
    if (busy) return;
    resetAll();
    const name = `${deployment.registeredModel} versión ${deployment.version}`;
    setAnnouncement({ pending: `Quitando ${name}`, done: `Se quitó ${name}` });
    remove.mutate(deployment.id, { onSuccess: focusDeployments });
  };

  const result = deploy.data;
  const failure = deploy.isError
    ? { error: deploy.error, fallback: "No se pudo desplegar." }
    : inference.isError
      ? {
          error: inference.error,
          fallback: "No se pudo cambiar la inferencia.",
        }
      : remove.isError
        ? { error: remove.error, fallback: "No se pudo quitar el despliegue." }
        : undefined;
  const mlflowUrl =
    catalog.data?.mlflowUrl && /^https?:\/\//.test(catalog.data.mlflowUrl)
      ? catalog.data.mlflowUrl
      : undefined;

  return (
    <>
      <LiveStatus
        pending={busy}
        succeeded={deploy.isSuccess || inference.isSuccess || remove.isSuccess}
        pendingText={announcement.pending}
        doneText={announcement.done}
      />
      {result ? (
        result.status === "ACTIVE" ? (
          <section role="status" aria-label="Resultado del despliegue">
            <h2>Modelo aprobado</h2>
            <p>
              {result.registeredModel} versión {result.version}
            </p>
            <p className="muted">{describeMetrics(result.gate)}</p>
          </section>
        ) : (
          <section role="alert" aria-label="Resultado del despliegue">
            <h2>Modelo rechazado</h2>
            <p>
              {result.registeredModel} versión {result.version}
            </p>
            {result.gate ? <GateReportView gate={result.gate} /> : null}
          </section>
        )
      ) : null}
      {failure ? (
        <p role="alert">
          {describeModelsFailure(failure.error, failure.fallback)}
        </p>
      ) : null}

      <section
        aria-labelledby="deployments-title"
        aria-busy={(deployments.isFetching && !polling) || undefined}
        className="screen-stack"
      >
        <h2 id="deployments-title" ref={deploymentsTitle} tabIndex={-1}>
          Despliegues
        </h2>
        {list ? (
          <p className="action-row">
            <span className="muted">
              {list.limits.activeCount}/{list.limits.maxActive} activos
            </span>
            {atCap ? <span className="muted">Máximo alcanzado</span> : null}
            {stalled && !deployments.isError ? (
              <button
                type="button"
                className="icon-button"
                aria-label="Actualizar despliegues"
                title="Actualizar despliegues"
                onClick={refresh}
              >
                <RefreshCw aria-hidden="true" focusable="false" size={16} />
              </button>
            ) : null}
            {!list.modelApiAvailable ? (
              <span
                className="status-icon"
                role="status"
                aria-label="Servicio de modelos no disponible"
                title="Servicio de modelos no disponible"
              >
                <ServerOff aria-hidden="true" focusable="false" size={16} />
              </span>
            ) : null}
          </p>
        ) : null}
        <QueryFeedback
          query={deployments}
          skeleton={3}
          loadingLabel="Cargando despliegues"
          error="No fue posible cargar los despliegues."
          staleError="No fue posible actualizar los despliegues."
          retryLabel="Reintentar despliegues"
        />
        {list && list.items.length === 0 ? (
          <EmptyState
            icon={Boxes}
            headingLevel={3}
            compact
            title="Sin despliegues"
          />
        ) : null}
        {list && list.items.length > 0 ? (
          <DeploymentList
            deployments={list.items}
            canDeploy={option.canDeploy}
            busy={busy}
            busyId={busyId}
            busyKind={busyKind}
            resultId={result?.id}
            onToggle={toggle}
            onRemove={quit}
          />
        ) : null}
      </section>

      <section
        aria-labelledby="catalog-title"
        aria-busy={catalog.isFetching || undefined}
        className="screen-stack"
      >
        <h2 id="catalog-title">Modelos registrados</h2>
        {mlflowUrl ? (
          <p>
            <a
              href={mlflowUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="button-with-icon"
            >
              Abrir MLflow
              <ExternalLink aria-hidden="true" focusable="false" size={16} />
              <span className="visually-hidden">
                {" "}
                (se abre en una pestaña nueva)
              </span>
            </a>
          </p>
        ) : null}
        <QueryFeedback
          query={catalog}
          skeleton={3}
          loadingLabel="Cargando modelos"
          error="No fue posible cargar los modelos."
          retryLabel="Reintentar modelos"
        />
        {catalog.data && catalog.data.models.length === 0 ? (
          <EmptyState
            icon={Boxes}
            headingLevel={3}
            compact
            title="Sin modelos registrados"
          />
        ) : null}
        {catalog.data && catalog.data.models.length > 0 ? (
          <ModelCatalog
            catalog={catalog.data}
            canDeploy={option.canDeploy}
            busy={busy}
            deployingKey={deployingKey}
            blocked={blocked}
            onDeploy={startDeploy}
          />
        ) : null}
        {catalog.data?.truncated ? (
          <span
            className="status-icon"
            role="img"
            aria-label="Solo los más recientes"
            title="Solo los más recientes"
          >
            <History aria-hidden="true" focusable="false" size={16} />
          </span>
        ) : null}
      </section>
    </>
  );
}
