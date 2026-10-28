import { Link } from "react-router";

import { LinkButton } from "../../../components/LinkButton";
import type { SelectionColumn } from "../../../components/SelectionTable";
import { fromApiRut } from "../../../lib/rut";
import type { Profile } from "../../auth/types";
import {
  MembersTableScreen,
  type MemberRow,
} from "../../members/MembersTableScreen";
import { paths } from "../../navigation/paths";
import { permissionRatio } from "../../permissions/types";
import { OrganizationGate } from "../components/OrganizationGate";
import { useOrgMembersQuery } from "../hooks/useOrgMembers";
import type { OrganizationMember } from "../types";
import { memberRoleLabel } from "../types/roles";

/** People of an organization, with selection for bulk permission edits. */
export function OrganizationMembersScreen({ profile }: { profile: Profile }) {
  return (
    <OrganizationGate
      profile={profile}
      manageOnly
      forbiddenTitle="Miembros"
      forbiddenMessage="Solo los administradores de la organización pueden ver a sus miembros."
    >
      {({ organization }) => (
        <MembersView key={organization.id} organization={organization} />
      )}
    </OrganizationGate>
  );
}

function MembersView({
  organization,
}: {
  organization: { id: string; name: string };
}) {
  const members = useOrgMembersQuery(organization.id);

  const columns: SelectionColumn<MemberRow<OrganizationMember>>[] = [
    {
      header: "Nombre",
      cell: ({ user }) => (
        <Link to={paths.organizationMember(organization.id, user.id)}>
          {user.name}
        </Link>
      ),
    },
    { header: "RUT", cell: ({ user }) => fromApiRut(user.rut) },
    { header: "Rol", cell: ({ role }) => memberRoleLabel(role) },
    {
      header: "Grupos",
      cell: ({ groups }) =>
        groups.length > 0
          ? groups.map(({ name }) => name).join(", ")
          : "Sin grupos",
    },
    {
      header: "Permisos",
      cell: ({ permissions }) => `${permissionRatio(permissions)} permisos`,
    },
  ];

  return (
    <MembersTableScreen
      query={members}
      backTo={paths.organization(organization.id)}
      backLabel={organization.name}
      eyebrow={organization.name}
      title="Miembros"
      description="Las personas de la organización, su rol, sus grupos y cuántos permisos sobre facturas tienen."
      action={
        <LinkButton to={paths.newOrganizationMember(organization.id)}>
          Agregar miembro
        </LinkButton>
      }
      messages={{
        loading: "Cargando miembros...",
        error: "No fue posible cargar los miembros.",
        staleError:
          "No fue posible actualizar la lista de miembros. Tus cambios ya se guardaron; no repitas la operación.",
        retryLabel: "Reintentar miembros",
        empty: "Esta organización no tiene miembros.",
      }}
      tableLabel="Miembros de la organización"
      columns={columns}
      bulkPath={(userIds) =>
        paths.bulkOrganizationPermissions(organization.id, userIds)
      }
    />
  );
}
