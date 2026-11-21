import { isUuid } from "../../lib/uuid";
import type { Profile } from "../auth/types";
import type { ModelsContext } from "./types";

export interface ModelsContextOption extends ModelsContext {
  /** Stable, unique `<option value>`. */
  value: string;
  /** «Organización · Acme» or «Grupo Compras · Acme». */
  label: string;
  /** May deploy here (effective `deployModels`): presentation only, the API decides. */
  canDeploy: boolean;
}

/**
 * Contexts the Models section can act in: for every organization with
 * `mlEnabled` on, the organization itself and each group the person belongs
 * to. The server stays the authority and answers 403/404 to anything else.
 */
export function modelsContextOptions({
  memberships,
}: Pick<Profile, "memberships">): ModelsContextOption[] {
  return memberships
    .filter(({ organization }) => organization.mlEnabled === true)
    .flatMap(({ organization, permissions, groups }) => [
      {
        value: `org:${organization.id}`,
        label: `Organización · ${organization.name}`,
        organizationId: organization.id,
        groupId: null,
        canDeploy: permissions.deployModels === true,
      },
      ...groups.map(({ group, effective }) => ({
        value: `group:${organization.id}:${group.id}`,
        label: `Grupo ${group.name} · ${organization.name}`,
        organizationId: organization.id,
        groupId: group.id,
        canDeploy: effective.deployModels === true,
      })),
    ]);
}

/** The option the URL asks for, else the first one (the screen's default). */
export function selectedModelsContext(
  options: readonly ModelsContextOption[],
  params: URLSearchParams,
): ModelsContextOption | undefined {
  const organizationId = params.get("organizationId");
  const groupId = params.get("groupId");
  if (organizationId && isUuid(organizationId)) {
    const wanted = options.find(
      (option) =>
        option.organizationId === organizationId &&
        option.groupId === (groupId && isUuid(groupId) ? groupId : null),
    );
    if (wanted) return wanted;
  }
  return options[0];
}

/** «Modelos» is offered when any organization of the person turned it on. */
export const hasModelsAccess = (profile: Pick<Profile, "memberships">) =>
  modelsContextOptions(profile).length > 0;
