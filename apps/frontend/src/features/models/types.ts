/** Wire types of the Models API (MLOPS-05). Reason codes are stable ids. */

export interface GateReason {
  code: string;
  message: string;
  detail: Record<string, unknown>;
}

export interface GateMetrics {
  auc: number | null;
  dummyAuc: number | null;
  lift: number | null;
  minAuc: number | null;
  minLift: number | null;
  validationRows: number | null;
}

export interface GateReport {
  passed: boolean;
  metrics: GateMetrics | null;
  reasons: GateReason[];
  featureSchemaVersion: string | null;
  checkedAt: string;
}

export type DeploymentStatus =
  "CHECKING" | "ACTIVE" | "INACTIVE" | "FAILED" | "QUARANTINED";

export interface Deployment {
  id: string;
  organizationId: string;
  groupId: string | null;
  workspace: string;
  registeredModel: string;
  version: string;
  runId: string | null;
  status: DeploymentStatus;
  inferenceEnabled: boolean;
  /** ACTIVE only: whether the Model API serves it right now; null = unknown. */
  loaded: boolean | null;
  gate: GateReport | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentList {
  items: Deployment[];
  limits: { activeCount: number; maxActive: number; maxChecksPerHour: number };
  modelApiAvailable: boolean;
}

export interface RegisteredModelVersion {
  version: string;
  runId: string | null;
  createdAt: string | null;
  gateStatus: string | null;
}

export interface RegisteredModel {
  name: string;
  versions: RegisteredModelVersion[];
}

export interface ModelCatalog {
  workspace: string;
  mlflowUrl: string | null;
  models: RegisteredModel[];
  truncated: boolean;
}

/** Where the Models section acts: an organization or one of its groups. */
export interface ModelsContext {
  organizationId: string;
  groupId: string | null;
}

export interface DeployInput extends ModelsContext {
  registeredModel: string;
  version: string;
}
