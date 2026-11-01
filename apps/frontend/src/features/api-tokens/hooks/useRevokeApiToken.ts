import { useMutation, useQueryClient } from "@tanstack/react-query";

import { isApiError } from "../../auth/api/apiError";
import { useIdentityId } from "../../auth/hooks/useSession";
import { apiTokensKey, profileKey } from "../../auth/session/queryKeys";
import { revokeApiToken } from "../api/apiTokensApi";

/**
 * Revokes one own token. The mutation settles once the lists were read again,
 * so the screen that closes its dialog on success already shows «Revocado».
 * The API repeats a 204 for a token that is already revoked.
 */
export function useRevokeApiToken() {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const refresh = () =>
    client.invalidateQueries({ queryKey: apiTokensKey(identityId) });
  return useMutation({
    mutationKey: ["api-tokens", "revoke"],
    mutationFn: (tokenId: string) => revokeApiToken(tokenId),
    onSuccess: refresh,
    onError: (error) => {
      if (isApiError(error) && error.status === 404) void refresh();
      if (isApiError(error) && error.status === 403)
        void client.invalidateQueries({ queryKey: profileKey(identityId) });
    },
  });
}
