import { useId } from "react";

import { PendingLabel } from "../../../components/PendingLabel";
import { DataTable, type DataColumn } from "../../../components/DataTable";
import { formatInstant } from "../../../lib/datetime";
import { describeDeployBlock, type DeployBlock } from "../gateReasons";
import type { RegisteredModelVersion } from "../types";
import type { ModelCatalog as Catalog } from "../types";

interface Row extends RegisteredModelVersion {
  id: string;
  model: string;
}

/**
 * Registered models and versions. The «Desplegar» button belongs to people who
 * may deploy. When it is blocked, the reason (already live, scope full) is
 * hidden text that the button points to with `aria-describedby`, and the
 * tooltip; while the list is still loading it is blocked without a reason.
 */
function DeployButton({
  model,
  version,
  block,
  busy,
  pending,
  onDeploy,
}: {
  model: string;
  version: string;
  block: DeployBlock | undefined;
  busy: boolean;
  pending: boolean;
  onDeploy: () => void;
}) {
  const reasonId = useId();
  const reason = block ? describeDeployBlock(block) : undefined;
  return (
    <>
      <button
        type="button"
        aria-label={`Desplegar ${model} versión ${version}`}
        className={pending ? "is-pending" : undefined}
        title={reason}
        aria-busy={pending || undefined}
        aria-describedby={reason ? reasonId : undefined}
        aria-disabled={block || busy ? true : undefined}
        onClick={() => {
          if (!block && !busy) onDeploy();
        }}
      >
        <PendingLabel pending={pending}>Desplegar</PendingLabel>
      </button>
      {reason ? (
        <span id={reasonId} className="visually-hidden">
          {reason}
        </span>
      ) : null}
    </>
  );
}

/** Registered models and versions; see `DeployButton` for the blocked states. */
export function ModelCatalog({
  catalog,
  canDeploy,
  busy,
  deployingKey,
  blocked,
  onDeploy,
}: {
  catalog: Catalog;
  canDeploy: boolean;
  /** Any model request in flight: deploying is inert. */
  busy: boolean;
  /** `model@version` being deployed right now. */
  deployingKey: string | undefined;
  /** Why a (model, version) cannot be deployed now; undefined = it can. */
  blocked: (model: string, version: string) => DeployBlock | undefined;
  onDeploy: (model: string, version: string) => void;
}) {
  const rows: Row[] = catalog.models.flatMap((model) =>
    model.versions.map((version) => ({
      ...version,
      id: `${model.name}@${version.version}`,
      model: model.name,
    })),
  );
  const columns: DataColumn<Row>[] = [
    { header: "Modelo", cell: ({ model }) => model },
    { header: "Versión", cell: ({ version }) => version },
    {
      header: "Registrada",
      cell: ({ createdAt }) => (createdAt ? formatInstant(createdAt) : "—"),
    },
  ];
  if (canDeploy)
    columns.push({
      header: "Acciones",
      cell: ({ id, model, version }) => (
        <DeployButton
          model={model}
          version={version}
          block={blocked(model, version)}
          busy={busy}
          pending={deployingKey === id}
          onDeploy={() => onDeploy(model, version)}
        />
      ),
    });
  return (
    <DataTable label="Modelos registrados" rows={rows} columns={columns} />
  );
}
