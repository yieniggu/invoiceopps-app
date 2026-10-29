import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { PageHeader } from "../../../components/PageHeader";
import { PaginationControls } from "../../../components/PaginationControls";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { SearchForm } from "../../../components/SearchForm";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { Toast } from "../../../components/Toast";
import {
  parsePage,
  useOutOfRangeRedirect,
} from "../../navigation/useListParams";
import { useRouteNotice } from "../../navigation/useRouteNotice";
import { useOrgUsersPageQuery } from "../../users/hooks/useUsers";
import { AddMembersForm } from "../components/AddMembersForm";
import { GroupGate, type GroupContext } from "../components/GroupGate";
import { useGroupMembersByIdsQuery } from "../hooks/useGroups";

/** Adds several organization members to a group, each with their permissions. */
export function AddGroupMembersScreen({ profile }: { profile: Profile }) {
  return (
    <GroupGate
      profile={profile}
      manageOnly
      forbiddenTitle="Agregar miembros al grupo"
      forbiddenMessage="Solo los administradores de la organización pueden agregar miembros a un grupo."
    >
      {(context) => <AddMembersView {...context} />}
    </GroupGate>
  );
}

/** People per page of the picker: one request, and one by-ids lookup of ≤ 20 ids. */
const PAGE_SIZE = 20;

/** `?search=&page=`: only non-default values, so the clean URL stays clean. */
const listSearch = (search: string, page: number) => {
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `?${text}` : "";
};

function AddMembersView({ organization, group }: GroupContext) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const notice = useRouteNotice();
  const search = params.get("search")?.trim() ?? "";
  const page = parsePage(params.get("page"));
  // One page of the organization's people, searched on the server.
  const users = useOrgUsersPageQuery(organization.id, {
    page,
    pageSize: PAGE_SIZE,
    ...(search ? { search } : {}),
  });
  const usersSettled = !!users.data && !users.isPlaceholderData;
  const pageUsers = useMemo(() => users.data?.users ?? [], [users.data]);
  const pageIds = useMemo(() => pageUsers.map(({ id }) => id), [pageUsers]);
  // Who is already inside is asked by id for the people on this page only
  // (at most PAGE_SIZE ids), so a group or an organization of any size is read
  // correctly without walking either of them.
  const members = useGroupMembersByIdsQuery(
    organization.id,
    group.id,
    pageIds,
    { enabled: usersSettled && pageIds.length > 0 },
  );
  const ready =
    usersSettled && (pageIds.length === 0 || members.data !== undefined);
  const memberIds = useMemo(
    () => new Set((members.data ?? []).map(({ userId }) => userId)),
    [members.data],
  );
  const pageMemberIds = useMemo(
    () =>
      ready ? new Set(pageIds.filter((id) => memberIds.has(id))) : undefined,
    [ready, pageIds, memberIds],
  );
  const candidates = useMemo(
    () =>
      ready ? pageUsers.filter(({ id }) => !memberIds.has(id)) : undefined,
    [ready, pageUsers, memberIds],
  );
  const go = (next: { search?: string; page?: number }) =>
    navigate({
      search: listSearch(next.search ?? search, next.page ?? page),
    });
  const outOfRange = useOutOfRangeRedirect(
    {
      page,
      pageSize: users.data?.pageSize || PAGE_SIZE,
      total: users.data?.total,
      rowCount: pageUsers.length,
      settled: usersSettled,
    },
    (last) => listSearch(search, last),
  );
  const emptyMessage =
    !ready || outOfRange || (candidates?.length ?? 0) > 0
      ? undefined
      : pageUsers.length > 0
        ? "Todas las personas de esta página ya están en el grupo."
        : search
          ? "Ninguna persona coincide con la búsqueda."
          : "La organización no tiene personas para agregar.";

  return (
    <div className="screen-stack">
      <BackLink to={paths.groupMembers(organization.id, group.id)}>
        Miembros del grupo
      </BackLink>
      <PageHeader
        eyebrow={`${organization.name} · ${group.name}`}
        title="Agregar miembros al grupo"
        description="Elige a las personas de la organización que se suman al grupo y define los permisos sobre facturas de cada una."
      />
      <Toast message={notice.message} noticeId={notice.id} />
      <SearchForm
        label="Buscar por nombre o RUT"
        initial={search}
        onSearch={(text) => go({ search: text, page: 1 })}
      />
      <QueryFeedback
        query={users}
        loading="Cargando personas de la organización..."
        error="No fue posible cargar las personas de la organización."
        retryLabel="Reintentar personas"
      />
      {/* The group is asked about the people on this page, so it waits. */}
      {usersSettled && pageIds.length > 0 ? (
        <QueryFeedback
          query={members}
          loading="Cargando miembros del grupo..."
          error="No fue posible cargar los miembros del grupo."
          retryLabel="Reintentar miembros del grupo"
        />
      ) : null}
      {/* Always mounted: the people chosen on other pages stay chosen while
          the page or the search changes. */}
      <AddMembersForm
        organizationId={organization.id}
        groupId={group.id}
        candidates={candidates}
        pageMemberIds={pageMemberIds}
        emptyMessage={emptyMessage}
        pager={
          users.data && users.data.total > 0 ? (
            <PaginationControls
              page={page}
              pageSize={users.data.pageSize || PAGE_SIZE}
              total={users.data.total}
              busy={users.isPlaceholderData}
              onPageChange={(next) => go({ page: next })}
            />
          ) : null
        }
        onAdded={(count) =>
          navigate(paths.groupMembers(organization.id, group.id), {
            state: {
              notice:
                count === 1
                  ? "1 persona agregada al grupo."
                  : `${count} personas agregadas al grupo.`,
            },
          })
        }
      />
    </div>
  );
}
