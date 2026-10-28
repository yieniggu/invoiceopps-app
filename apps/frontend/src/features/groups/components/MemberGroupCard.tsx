import { useState } from "react";
import { Link } from "react-router";

import { CollapsibleSection } from "../../../components/CollapsibleSection";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { paths } from "../../navigation/paths";
import { SavedMemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import {
  permissionRatio,
  type InvoicePermissions,
} from "../../permissions/types";
import type { useRemoveGroupMember } from "../hooks/useGroups";

/**
 * One group a person belongs to, seen from the person's page. The flags in
 * that group come with the organization's membership list (no request per
 * group). The removal mutation belongs to the parent, which stays mounted
 * after the card is gone, so its outcome can be announced in a live region
 * that does not unmount with the card.
 */
export function MemberGroupCard({
  organizationId,
  group,
  userId,
  userName,
  remove,
  onRemoved,
}: {
  organizationId: string;
  group: { groupId: string; name: string; permissions: InvoicePermissions };
  userId: string;
  userName: string;
  remove: ReturnType<typeof useRemoveGroupMember>;
  /** Called with the confirmation text once the person left the group. */
  onRemoved: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The shared mutation reports only the removal that targets this card.
  const mine = remove.variables?.groupId === group.groupId;

  return (
    <CollapsibleSection
      title={group.name}
      summary={`${permissionRatio(group.permissions)} permisos`}
      open={open}
      onToggle={() => setOpen((current) => !current)}
    >
      <p>
        <Link to={paths.group(organizationId, group.groupId)}>
          Ver grupo {group.name}
        </Link>
      </p>
      <SavedMemberPermissionsEditor
        memberName={userName}
        scopeName={group.name}
        target={{
          level: "group",
          organizationId,
          groupId: group.groupId,
          userId,
        }}
        saved={group.permissions}
      />
      <div className="action-row">
        <ConfirmAction
          label={`Quitar del grupo ${group.name}`}
          confirmLabel={`Confirmar quitar del grupo ${group.name}`}
          disabled={remove.isPending}
          onConfirm={() =>
            remove.mutate(
              { groupId: group.groupId, userId },
              {
                onSuccess: () =>
                  onRemoved(`Se quitó a ${userName} del grupo ${group.name}.`),
              },
            )
          }
        />
      </div>
      <MutationFeedback
        isError={mine && remove.isError}
        error={remove.error}
        isSuccess={false}
        success=""
        fallback="No fue posible quitar a la persona del grupo. Intenta nuevamente."
        focusOnError
      />
    </CollapsibleSection>
  );
}
