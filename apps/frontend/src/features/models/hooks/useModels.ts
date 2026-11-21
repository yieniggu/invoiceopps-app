import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useBoundedPolling } from "../../../lib/boundedPolling";
import { useIdentityId } from "../../auth/hooks/useSession";
import {
  deploymentsKey,
  modelsKey,
  profileKey,
} from "../../auth/session/queryKeys";
import { isApiError } from "../../auth/api/apiError";
import {
  deployModel,
  listDeployments,
  listModels,
  removeDeployment,
  setInference,
} from "../api/modelsApi";
import type { DeployInput, DeploymentList, ModelsContext } from "../types";

/** 403/404 on a Models read: the section or the access went away. */
const isAccessLoss = (error: unknown) =>
  isApiError(error) && (error.status === 403 || error.status === 404);

/**
 * Models of the context. Model-service outages stay inside this query; a
 * 403/404 refreshes the profile, whose `mlEnabled` and permissions decide
 * whether the screen is still reachable.
 */
export function useModelCatalog(context: ModelsContext) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return useQuery({
    queryKey: modelsKey(identityId, context),
    queryFn: async ({ signal }) => {
      try {
        return await listModels(context, signal);
      } catch (error) {
        if (isAccessLoss(error))
          void client.invalidateQueries({ queryKey: profileKey(identityId) });
        throw error;
      }
    },
    retry: false,
  });
}

/** Deployments still being verified: the only ones that change by themselves. */
export const hasCheckingDeployments = (list: DeploymentList | undefined) =>
  list?.items.some((item) => item.status === "CHECKING") === true;

/**
 * Deployments of the context. While any is CHECKING the list is polled for a
 * bounded time (`useBoundedPolling`, the same rule as invoice predictions);
 * `stalled` says it gave up and `refresh` starts another run. A 403/404
 * refreshes the profile like the catalogue does.
 */
export function useDeployments(context: ModelsContext) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const polling = useBoundedPolling<DeploymentList>(
    `${context.organizationId}:${context.groupId ?? ""}`,
    hasCheckingDeployments,
  );
  const query = useQuery({
    queryKey: deploymentsKey(identityId, context),
    queryFn: async ({ signal }) => {
      try {
        return await listDeployments(context, signal);
      } catch (error) {
        if (isAccessLoss(error))
          void client.invalidateQueries({ queryKey: profileKey(identityId) });
        throw error;
      }
    },
    retry: false,
    refetchInterval: polling.refetchInterval,
  });
  const { active, gaveUp } = polling.observe(
    query.data,
    query.dataUpdatedAt,
    query.errorUpdatedAt,
  );
  return {
    query,
    stalled: gaveUp,
    /** Polling is running: its refetches are background, not a busy section. */
    polling: active && !gaveUp,
    refresh: () => {
      polling.restart();
      void query.refetch();
    },
  };
}

/** Refreshes the deployments; a 404/403 means the section or access went away. */
function useRefreshDeployments(context: ModelsContext) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return {
    refresh: () =>
      client.invalidateQueries({
        queryKey: deploymentsKey(identityId, context),
      }),
    onError: (error: unknown) => {
      if (isApiError(error) && (error.status === 404 || error.status === 403))
        void client.invalidateQueries({ queryKey: profileKey(identityId) });
    },
  };
}

export function useDeployModel(context: ModelsContext) {
  const { refresh, onError } = useRefreshDeployments(context);
  return useMutation({
    mutationKey: ["models", "deploy"],
    mutationFn: (input: DeployInput) => deployModel(input),
    onSuccess: refresh,
    onError: (error) => {
      onError(error);
      // 409/429 change what the list says (limits, live versions).
      void refresh();
    },
  });
}

export function useSetInference(context: ModelsContext) {
  const { refresh, onError } = useRefreshDeployments(context);
  return useMutation({
    mutationKey: ["models", "inference"],
    mutationFn: ({
      deploymentId,
      enabled,
    }: {
      deploymentId: string;
      enabled: boolean;
    }) => setInference(deploymentId, context, enabled),
    onSuccess: refresh,
    onError: (error) => {
      onError(error);
      void refresh();
    },
  });
}

export function useRemoveDeployment(context: ModelsContext) {
  const { refresh, onError } = useRefreshDeployments(context);
  return useMutation({
    mutationKey: ["models", "remove"],
    mutationFn: (deploymentId: string) =>
      removeDeployment(deploymentId, context),
    onSuccess: refresh,
    onError: (error) => {
      onError(error);
      // 409/504 leave the state unknown: the list says what really happened.
      void refresh();
    },
  });
}
