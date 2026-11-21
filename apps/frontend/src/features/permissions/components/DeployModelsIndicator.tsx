import { Boxes } from "lucide-react";

import { permissionRatio, type InvoicePermissions } from "../types";

/**
 * «Despliega modelos» as an icon with an accessible name, shown next to a
 * permission summary when the flag is on. The invoice ratio ("2 de 4") covers
 * the four invoice flags only, so without this the model flag would be
 * invisible in every summary.
 */
export function DeployModelsIndicator({
  permissions,
}: {
  permissions: Pick<InvoicePermissions, "deployModels">;
}) {
  if (!permissions.deployModels) return null;
  return (
    <span
      className="status-icon"
      role="img"
      aria-label="Despliega modelos"
      title="Despliega modelos"
    >
      <Boxes aria-hidden="true" focusable="false" size={16} />
    </span>
  );
}

/** "2 de 4 permisos" plus the «Despliega modelos» indicator when it applies. */
export function PermissionRatio({
  permissions,
}: {
  permissions: InvoicePermissions;
}) {
  return (
    <>
      {permissionRatio(permissions)} permisos
      <DeployModelsIndicator permissions={permissions} />
    </>
  );
}
