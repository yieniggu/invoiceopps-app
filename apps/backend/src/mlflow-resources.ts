import type { AuthProfile } from "./auth.js";
import { AuthError } from "./auth.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { assertResourceContext, type ResourceContext } from "./resources.js";
import {
  MlflowReadError,
  withMlflowDeadline,
  type MlflowReader,
} from "./mlflow-read-client.js";

export interface MlflowResourceService {
  listResources(
    actor: Pick<AuthProfile, "id" | "rut">,
    context: ResourceContext,
    signal?: AbortSignal,
  ): Promise<{
    experiment: { id: string; name: string; url?: string } | null;
    runs: Array<{ runId: string; url?: string }>;
    registeredModel: { name: string; url?: string } | null;
    versions: Array<{ version: string; url?: string; runId?: string }>;
    truncated: boolean;
    fetchedAt: string;
  }>;
}

export function createMlflowResourceService(
  prisma: PrismaClient,
  reader:
    | MlflowReader
    | {
        withDeadline<T>(
          work: (reader: MlflowReader) => Promise<T>,
          signal?: AbortSignal,
        ): Promise<T>;
      }
    | undefined,
  uiOrigin?: string,
): MlflowResourceService {
  return {
    async listResources(actor, context, requestSignal) {
      const list = async (signal: AbortSignal) => {
        await assertResourceContext(prisma, actor.id, context, signal);
        signal.throwIfAborted();
        const [organization, user] = await Promise.all([
          prisma.organization.findUnique({
            where: { id: context.organizationId },
            select: { slug: true },
          }),
          prisma.user.findUnique({
            where: { id: actor.id },
            select: { rut: true },
          }),
        ]);
        signal.throwIfAborted();
        if (
          !organization ||
          !user ||
          user.rut !== actor.rut ||
          !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])$/.test(organization.slug) ||
          !/^[0-9]{7,8}[0-9K]$/.test(user.rut) ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            context.ownerId,
          )
        ) {
          throw new AuthError(404, "Resource context not found");
        }
        const workspace = organization.slug;
        const name =
          context.ownerType === "user"
            ? `student/${user.rut}/invoice-risk`
            : `group/${context.ownerId}/invoice-risk`;
        const modelName =
          context.ownerType === "user"
            ? `student-${user.rut}-invoice-review`
            : `group-${context.ownerId}-invoice-review`;
        const expectedTags = {
          organization_slug: workspace,
          owner_type: context.ownerType,
          owner_id: context.ownerId,
        };
        const matches = (tags: Record<string, string>) =>
          Object.entries(expectedTags).every(
            ([key, value]) => tags[key] === value,
          ) &&
          (context.ownerType === "user"
            ? tags.created_by_rut === user.rut
            : /^[0-9]{7,8}[0-9K]$/.test(tags.created_by_rut ?? ""));
        const link = (path: string) =>
          uiOrigin
            ? `${uiOrigin}/#${path}?workspace=${encodeURIComponent(workspace)}`
            : undefined;

        const discover = async (active: MlflowReader) => {
          const [experiment, model] = await Promise.all([
            active.getExperimentByName({ workspace, name }),
            active.getRegisteredModel({ workspace, name: modelName }),
          ]);
          if (
            experiment &&
            (experiment.name !== name ||
              !/^[a-zA-Z0-9_-]{1,64}$/.test(experiment.experimentId))
          ) {
            throw new MlflowReadError(502, "INVALID_RESPONSE");
          }
          const ownedModel =
            model && model.name === modelName && matches(model.tags)
              ? model
              : null;
          const [runPage, versionPage] = await Promise.all([
            experiment
              ? active.listRuns({
                  workspace,
                  experimentId: experiment.experimentId,
                  organizationSlug: workspace,
                  ownerType: context.ownerType,
                  ownerId: context.ownerId,
                  createdByRut:
                    context.ownerType === "user" ? user.rut : undefined,
                })
              : Promise.resolve({ items: [], truncated: false }),
            ownedModel
              ? active.listVersions({ workspace, name: modelName })
              : Promise.resolve({ items: [], truncated: false }),
          ]);
          const runs = runPage.items
            .filter(
              (run) =>
                experiment &&
                run.experimentId === experiment.experimentId &&
                matches(run.tags) &&
                /^[a-zA-Z0-9_-]{1,64}$/.test(run.runId),
            )
            .map((run) => ({
              runId: run.runId,
              url: link(
                `/experiments/${encodeURIComponent(experiment!.experimentId)}/runs/${encodeURIComponent(run.runId)}`,
              ),
            }));
          const versions = versionPage.items
            .filter(
              (version) =>
                version.name === modelName &&
                /^[0-9]{1,12}$/.test(version.version),
            )
            .map((version) => ({
              version: version.version,
              url: link(
                `/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version.version)}`,
              ),
              // A version's source run is only trusted if it is among the verified runs.
              ...(version.runId &&
              runs.some((run) => run.runId === version.runId)
                ? { runId: version.runId }
                : {}),
            }));
          return {
            experiment: experiment
              ? {
                  id: experiment.experimentId,
                  name,
                  url: link(
                    `/experiments/${encodeURIComponent(experiment.experimentId)}`,
                  ),
                }
              : null,
            runs,
            registeredModel: ownedModel
              ? {
                  name: modelName,
                  url: link(`/models/${encodeURIComponent(modelName)}`),
                }
              : null,
            versions,
            truncated: runPage.truncated || versionPage.truncated,
            fetchedAt: new Date().toISOString(),
          };
        };
        if (!reader) throw new MlflowReadError(503, "NOT_CONFIGURED");
        return "withDeadline" in reader
          ? reader.withDeadline(discover, signal)
          : discover(reader);
      };
      return requestSignal ? list(requestSignal) : withMlflowDeadline(list);
    },
  };
}
