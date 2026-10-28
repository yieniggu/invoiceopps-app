import { apiRequest } from "../../auth/api/apiRequest";
import type {
  AssignMemberInput,
  CreateOrganizationInput,
  Organization,
  OrganizationMember,
  OrganizationRole,
  OrganizationSummary,
} from "../types";

const base = (organizationId: string) =>
  `/api/v1/organizations/${encodeURIComponent(organizationId)}`;

export const listOrganizations = (signal?: AbortSignal) =>
  apiRequest<{ organizations: Organization[] }>("/api/v1/organizations", {
    signal,
  }).then((result) => result.organizations);

export const createOrganization = (input: CreateOrganizationInput) =>
  apiRequest<{ organization: Organization }>("/api/v1/organizations", {
    method: "POST",
    body: input,
  }).then(({ organization }) => ({ organizationId: organization.id }));

export const getOrganization = (organizationId: string, signal?: AbortSignal) =>
  apiRequest<OrganizationSummary>(base(organizationId), { signal });

export const listMemberships = (organizationId: string, signal?: AbortSignal) =>
  apiRequest<{ memberships: OrganizationMember[] }>(
    `${base(organizationId)}/memberships`,
    { signal },
  ).then((result) => result.memberships);

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
