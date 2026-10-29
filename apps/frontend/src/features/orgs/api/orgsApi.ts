import { apiRequest } from "../../auth/api/apiRequest";
import {
  inChunks,
  mapWithConcurrency,
  MAX_CONCURRENT_REQUESTS,
  MAX_PAGE_SIZE,
  withQuery,
} from "../../../lib/pagination";
import type {
  AssignMemberInput,
  CreateOrganizationInput,
  MemberBasicPage,
  MembershipPage,
  Organization,
  OrganizationBasic,
  OrganizationPage,
  OrganizationRole,
  OrganizationSummary,
  PageRequest,
  UpdateOrganizationInput,
  UserBasic,
} from "../types";

const base = (organizationId: string) =>
  `/api/v1/organizations/${encodeURIComponent(organizationId)}`;

/** The largest page the server allows; screens without paging UI ask for it. */
export const FIRST_PAGE: PageRequest = { page: 1, pageSize: MAX_PAGE_SIZE };

export const listOrganizations = (
  params: PageRequest & { search?: string } = FIRST_PAGE,
  signal?: AbortSignal,
) =>
  apiRequest<OrganizationPage>(withQuery("/api/v1/organizations", params), {
    signal,
  });

export const updateOrganization = (
  organizationId: string,
  input: UpdateOrganizationInput,
) =>
  apiRequest<{ organization: OrganizationBasic }>(base(organizationId), {
    method: "PATCH",
    body: input,
  }).then(({ organization }) => organization);

export const listOrganizationMembers = (
  organizationId: string,
  params: PageRequest = FIRST_PAGE,
  signal?: AbortSignal,
) =>
  apiRequest<MemberBasicPage>(
    withQuery(`${base(organizationId)}/members`, params),
    { signal },
  );

export const getUserBasic = (userId: string, signal?: AbortSignal) =>
  apiRequest<UserBasic>(`/api/v1/users/${encodeURIComponent(userId)}`, {
    signal,
  });

export const createOrganization = (input: CreateOrganizationInput) =>
  apiRequest<{ organization: Organization }>("/api/v1/organizations", {
    method: "POST",
    body: input,
  }).then(({ organization }) => ({ organizationId: organization.id }));

export const getOrganization = (organizationId: string, signal?: AbortSignal) =>
  apiRequest<OrganizationSummary>(base(organizationId), { signal });

export const listMemberships = (
  organizationId: string,
  params: PageRequest & { userIds?: readonly string[] } = FIRST_PAGE,
  signal?: AbortSignal,
) =>
  apiRequest<MembershipPage>(
    withQuery(`${base(organizationId)}/memberships`, params),
    { signal },
  );

/** Ids per request: one page holds at most 100 memberships. */
const IDS_PER_REQUEST = FIRST_PAGE.pageSize;

/**
 * The memberships of exactly these people (those who are not members are
 * absent), however far down the organization's list they would sort. Large
 * selections go in chunks that each fit one page, at most four requests at a
 * time.
 */
export async function listMembershipsByIds(
  organizationId: string,
  userIds: readonly string[],
  signal?: AbortSignal,
) {
  const chunks = inChunks(userIds, IDS_PER_REQUEST);
  const pages = await mapWithConcurrency(
    chunks,
    MAX_CONCURRENT_REQUESTS,
    (chunk) =>
      listMemberships(
        organizationId,
        { ...FIRST_PAGE, userIds: chunk },
        signal,
      ),
  );
  const byUser = new Map(
    pages.flatMap((page) => page.memberships).map((m) => [m.userId, m]),
  );
  return [...byUser.values()];
}

export const assignMember = (
  organizationId: string,
  input: AssignMemberInput,
) =>
  apiRequest<{ membership: { userId: string } }>(
    `${base(organizationId)}/memberships`,
    { method: "POST", body: input },
  ).then(({ membership }) => ({ userId: membership.userId }));

export const changeMemberRole = (
  organizationId: string,
  userId: string,
  role: OrganizationRole,
) =>
  apiRequest<unknown>(
    `${base(organizationId)}/memberships/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: { role } },
  );

export const removeMember = (organizationId: string, userId: string) =>
  apiRequest<void>(
    `${base(organizationId)}/memberships/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
