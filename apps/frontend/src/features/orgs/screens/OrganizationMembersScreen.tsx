import { Link } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { DataTable, type DataColumn } from "../../../components/DataTable";
import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import { PaginationControls } from "../../../components/PaginationControls";
import { QueryFeedback } from "../../../components/QueryFeedback";
import type { SelectionColumn } from "../../../components/SelectionTable";
import { fromApiRut } from "../../../lib/rut";
import type { Profile } from "../../auth/types";
import {
  MembersTableScreen,
  type MemberRow,
} from "../../members/MembersTableScreen";
import { paths } from "../../navigation/paths";
import {
  pageSearch,
  usePageParam,
  useOutOfRangeRedirect,
} from "../../navigation/useListParams";
import { permissionRatio } from "../../permissions/types";
import { accountStatusLabel, activityLabel } from "../../users/presentation";
import { OrganizationGate } from "../components/OrganizationGate";
import {
  useOrgBasicMembersPageQuery,
  useOrgMembershipsPageQuery,
} from "../hooks/useOrgMembers";
import type { OrganizationMember, OrganizationMemberBasic } from "../types";
import { memberRoleLabel } from "../types/roles";

/** Rows per page of both member lists. */
const PAGE_SIZE = 20;

/**
 * People of an organization. Administrators (and the platform administrator)
 * get the management table with bulk permission edits; plain members get the
 * reduced list every member may read.
 */
export function OrganizationMembersScreen({ profile }: { profile: Profile }) {
  return (
    <OrganizationGate profile={profile}>
      {({ organization, canManage }) =>
        canManage ? (
          <ManagementView
            key={organization.id}
            organization={organization}
            isPlatformAdministrator={profile.isPlatformAdministrator}
          />
        ) : (
          <BasicMembersView key={organization.id} organization={organization} />
        )
      }
    </OrganizationGate>
  );
}

function ManagementView({
  organization,
  isPlatformAdministrator,
}: {
  organization: { id: string; name: string };
  isPlatformAdministrator: boolean;
}) {
  const { page, setPage } = usePageParam();
  const memberships = useOrgMembershipsPageQuery(organization.id, {
    page,
    pageSize: PAGE_SIZE,
  });

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
      header: "Estado",
      cell: ({ user }) => accountStatusLabel(user.disabled),
    },
    {
      header: "Actividad",
      cell: ({ user }) => activityLabel(user.recentlyActive),
    },
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
    ...(isPlatformAdministrator
      ? [
          {
            header: "Administración",
            cell: ({ user }: MemberRow<OrganizationMember>) => (
              <Link
                to={paths.adminUser(user.id)}
                aria-label={`Ver en Admin: ${user.name}`}
              >
                Ver en Admin
              </Link>
            ),
          },
        ]
      : []),
  ];

  return (
    <MembersTableScreen
      query={{
        data: memberships.data?.memberships,
        isPending: memberships.isPending,
        isError: memberships.isError,
        refetch: memberships.refetch,
      }}
      backTo={paths.organization(organization.id)}
      backLabel={organization.name}
      eyebrow={organization.name}
      title="Miembros"
      description="Las personas de la organización, su rol, su estado, sus grupos y cuántos permisos sobre facturas tienen."
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
      pagination={
        memberships.data
          ? {
              page,
              pageSize: memberships.data.pageSize || PAGE_SIZE,
              total: memberships.data.total,
              busy: memberships.isPlaceholderData,
              onPageChange: setPage,
            }
          : undefined
      }
    />
  );
}

type BasicRow = OrganizationMemberBasic & { id: string };

const BASIC_COLUMNS: DataColumn<BasicRow>[] = [
  {
    header: "Nombre",
    cell: ({ userId, name }) => <Link to={paths.user(userId)}>{name}</Link>,
  },
  { header: "Correo", cell: ({ email }) => email ?? "Sin correo" },
  {
    header: "Actividad",
    cell: ({ recentlyActive }) => activityLabel(recentlyActive),
  },
];

/** Reduced list for plain members: who else is here, no admin actions. */
function BasicMembersView({
  organization,
}: {
  organization: { id: string; name: string };
}) {
  const { page, setPage } = usePageParam();
  const members = useOrgBasicMembersPageQuery(organization.id, {
    page,
    pageSize: PAGE_SIZE,
  });
  const rows: BasicRow[] = (members.data?.members ?? []).map((member) => ({
    ...member,
    id: member.userId,
  }));
  const outOfRange = useOutOfRangeRedirect(
    {
      page,
      pageSize: members.data?.pageSize || PAGE_SIZE,
      total: members.data?.total,
      rowCount: rows.length,
      settled: !!members.data && !members.isPlaceholderData,
    },
    pageSearch,
  );

  return (
    <div className="screen-stack">
      <BackLink to={paths.organization(organization.id)}>
        {organization.name}
      </BackLink>
      <PageHeader
        eyebrow={organization.name}
        title="Miembros"
        description="Las personas que forman parte de esta organización."
      />
      <QueryFeedback
        query={members}
        loading="Cargando miembros..."
        error="No fue posible cargar los miembros."
        staleError="No fue posible actualizar la lista de miembros; lo que ves puede estar desactualizado."
        retryLabel="Reintentar miembros"
      />
      {members.data && rows.length === 0 && !outOfRange ? (
        <p>Esta organización no tiene miembros.</p>
      ) : null}
      {rows.length > 0 ? (
        <DataTable
          label="Miembros de la organización"
          rows={rows}
          columns={BASIC_COLUMNS}
        />
      ) : null}
      {members.data ? (
        <PaginationControls
          page={page}
          pageSize={members.data.pageSize || PAGE_SIZE}
          total={members.data.total}
          busy={members.isPlaceholderData}
          onPageChange={setPage}
        />
      ) : null}
    </div>
  );
}
