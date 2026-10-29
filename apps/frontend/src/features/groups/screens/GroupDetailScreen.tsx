import { BackLink } from "../../../components/BackLink";
import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { describePermissions } from "../../permissions/types";
import { GroupGate, type GroupContext } from "../components/GroupGate";
import { useGroupMembersPageQuery } from "../hooks/useGroups";

/** Summary of one group: its data, its member count and the way to its people. */
export function GroupDetailScreen({ profile }: { profile: Profile }) {
  return (
    <GroupGate profile={profile}>
      {(context) => <GroupSummary {...context} />}
    </GroupGate>
  );
}

function GroupSummary({
  organization,
  group,
  canManage,
  effective,
  refreshFailed,
  retry,
}: GroupContext) {
  // The member list is admin-only; a plain member sees their own flags
  // instead. One row is enough: the summary only shows how many there are.
  const members = useGroupMembersPageQuery(
    organization.id,
    group.id,
    { page: 1, pageSize: 1 },
    canManage,
  );

  return (
    <div className="screen-stack">
      <BackLink to={paths.organizationGroups(organization.id)}>
        Grupos de {organization.name}
      </BackLink>
      <PageHeader
        eyebrow={organization.name}
        title={group.name}
        description={
          canManage
            ? "Resumen del grupo. Desde «Miembros» defines quiénes lo integran y qué pueden hacer con las facturas en él."
            : "Estos son los permisos sobre facturas que tienes por pertenecer a este grupo."
        }
        action={
          canManage ? (
            <div className="header-actions">
              <LinkButton to={paths.groupMembers(organization.id, group.id)}>
                Miembros
              </LinkButton>
            </div>
          ) : undefined
        }
      />
      {refreshFailed ? (
        <>
          <p role="alert">
            No fue posible actualizar la lista de grupos. Tus cambios ya se
            guardaron; no repitas la operación.
          </p>
          <button type="button" onClick={retry}>
            Reintentar grupos
          </button>
        </>
      ) : null}
      <section aria-labelledby="group-summary-title">
        <h2 id="group-summary-title">Resumen</h2>
        <dl className="summary-list">
          <div>
            <dt>Nombre</dt>
            <dd>{group.name}</dd>
          </div>
          <div>
            <dt>Descripción</dt>
            <dd>{group.description ?? "Sin descripción"}</dd>
          </div>
          {canManage && members.data ? (
            <div>
              <dt>Miembros</dt>
              <dd>{members.data.total}</dd>
            </div>
          ) : null}
        </dl>
        {canManage ? (
          <QueryFeedback
            query={members}
            loading="Cargando miembros del grupo..."
            error="No fue posible cargar los miembros del grupo."
            staleError="No fue posible actualizar los miembros del grupo."
            retryLabel="Reintentar miembros del grupo"
          />
        ) : null}
        {!canManage && effective ? (
          <p className="muted">{describePermissions(effective)}</p>
        ) : null}
      </section>
    </div>
  );
}
