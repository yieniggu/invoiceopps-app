import { CloudOff } from "lucide-react";

import { SwitchButton } from "../../../components/SwitchButton";
import { DataTable, type DataColumn } from "../../../components/DataTable";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { formatInstant } from "../../../lib/datetime";
import { STATUS_LABEL, STATUS_TONE } from "../gateReasons";
import type { Deployment } from "../types";
import { GateReportView } from "./GateReportView";

/**
 * Deployments of the context, history included. The «inferencia» toggle is a
 * switch (`SwitchButton`) that only ACTIVE deployments offer and only to
 * people who may deploy; quitting asks first. A rejected deployment shows its
 * reasons here unless the result panel of the screen already shows them
 * (`resultId`), so each reason appears once.
 */
export function DeploymentList({
  deployments,
  canDeploy,
  busy,
  busyId,
  busyKind,
  onToggle,
  onRemove,
  resultId,
}: {
  deployments: readonly Deployment[];
  canDeploy: boolean;
  /** Any model request in flight: every control is inert. */
  busy: boolean;
  /** Deployment with a request in flight: it shows the spinner. */
  busyId: string | undefined;
  /** What the busy deployment is doing: its switch or its removal. */
  busyKind: "toggle" | "remove" | undefined;
  onToggle: (deployment: Deployment, enabled: boolean) => void;
  onRemove: (deployment: Deployment) => void;
  /** Deployment whose gate report the result panel is showing right now. */
  resultId?: string;
}) {
  const columns: DataColumn<Deployment>[] = [
    {
      header: "Modelo",
      cell: (deployment) => (
        <>
          {deployment.registeredModel} · versión {deployment.version}
          {deployment.gate &&
          !deployment.gate.passed &&
          deployment.id !== resultId ? (
            <GateReportView gate={deployment.gate} />
          ) : null}
        </>
      ),
    },
    {
      header: "Estado",
      cell: (deployment) => (
        <>
          <span className={`status-badge ${STATUS_TONE[deployment.status]}`}>
            {STATUS_LABEL[deployment.status]}
          </span>
          {deployment.status === "ACTIVE" && deployment.loaded === false ? (
            <span
              className="status-icon"
              role="img"
              aria-label="No cargado en el servicio"
              title="No cargado en el servicio"
            >
              <CloudOff aria-hidden="true" focusable="false" size={16} />
            </span>
          ) : null}
        </>
      ),
    },
    {
      header: "Verificado",
      cell: ({ gate, createdAt }) =>
        formatInstant(gate?.checkedAt ?? createdAt),
    },
    {
      header: "Inferencia en facturas nuevas",
      cell: (deployment) => {
        if (deployment.status !== "ACTIVE")
          return <span className="muted">—</span>;
        const pending = busyId === deployment.id && busyKind === "toggle";
        return (
          <SwitchButton
            label="Inferencia"
            context={`en facturas nuevas de ${deployment.registeredModel} versión ${deployment.version}`}
            checked={deployment.inferenceEnabled}
            pending={pending}
            locked={!canDeploy || busy}
            title={
              canDeploy ? undefined : "Requiere el permiso «Desplegar modelos»"
            }
            onToggle={() => onToggle(deployment, !deployment.inferenceEnabled)}
          />
        );
      },
    },
    {
      header: "Acciones",
      cell: (deployment) =>
        canDeploy &&
        (deployment.status === "ACTIVE" ||
          deployment.status === "QUARANTINED") ? (
          <ConfirmAction
            label={`Quitar ${deployment.registeredModel} versión ${deployment.version}`}
            confirmLabel="Confirmar: quitar"
            disabled={busy}
            pending={busyId === deployment.id && busyKind === "remove"}
            onConfirm={() => onRemove(deployment)}
          />
        ) : null,
    },
  ];
  return (
    <DataTable
      label="Despliegues del contexto"
      rows={deployments}
      columns={columns}
    />
  );
}
