import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export type EvidenceAnchorAction = "anchor" | "reconcile";

export interface EvidenceAnchorEnvironment {
  EVM_RPC_URL?: string;
  EVM_CHAIN_ID?: string;
  EVIDENCE_CONTRACT_ADDRESS?: string;
  EVM_SIGNER_PRIVATE_KEY?: string;
}

export type EvidenceAnchorConfig =
  | { kind: "unavailable" }
  | {
      kind: "configured";
      target: { rpcUrl: string; chainId: number; contractAddress: string };
      signerAddress?: string;
      getAccount?: () => PrivateKeyAccount;
    };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STACK04_CHAIN_ID = 31337;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export class EvidenceAnchorConfigurationError extends Error {
  constructor() {
    super("Invalid evidence anchor configuration");
  }
}

function invalid(): never {
  throw new EvidenceAnchorConfigurationError();
}

function validateRpcUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  )
    return invalid();
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return invalid();
  }
  return value;
}

function validateTarget(rpcUrl: string, chainId: number): string {
  const validatedRpcUrl = validateRpcUrl(rpcUrl);
  const url = new URL(validatedRpcUrl);
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    if (chainId !== STACK04_CHAIN_ID) return invalid();
  }
  return validatedRpcUrl;
}

export function readEvidenceAnchorConfig(
  environment: EvidenceAnchorEnvironment,
  action: EvidenceAnchorAction,
): EvidenceAnchorConfig {
  const rpcUrl = environment.EVM_RPC_URL;
  const chainIdText = environment.EVM_CHAIN_ID;
  const contract = environment.EVIDENCE_CONTRACT_ADDRESS;
  const key =
    action === "anchor" ? environment.EVM_SIGNER_PRIVATE_KEY : undefined;
  if (
    [
      rpcUrl,
      chainIdText,
      contract,
      ...(action === "anchor" ? [key] : []),
    ].every((value) => value === undefined || value === "")
  ) {
    return { kind: "unavailable" };
  }
  if (!rpcUrl || !chainIdText || !contract || (action === "anchor" && !key))
    return invalid();
  if (!/^[1-9]\d*$/.test(chainIdText)) return invalid();
  const chainId = Number(chainIdText);
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !ADDRESS.test(contract) ||
    contract.toLowerCase() === `0x${"0".repeat(40)}`
  )
    return invalid();
  const target = {
    chainId,
    contractAddress: contract.toLowerCase(),
    rpcUrl: validateTarget(rpcUrl, chainId),
  };
  Object.defineProperty(target, "toJSON", {
    value: () => ({ chainId, contractAddress: target.contractAddress }),
    enumerable: false,
  });
  if (action === "reconcile") return { kind: "configured", target };
  try {
    const account = privateKeyToAccount(key as `0x${string}`);
    const config = {
      kind: "configured" as const,
      target,
      signerAddress: account.address,
      getAccount: () => account,
      toJSON: () => ({
        kind: "configured",
        target: { chainId, contractAddress: target.contractAddress },
        signerAddress: account.address,
      }),
    };
    return config;
  } catch {
    return invalid();
  }
}
