# APP-11 CR-004 testnet readiness follow-up

## Current disposition

**Local database/session readiness is verified; full APP-11 and CR-004 remain
open.** The current managed local database has all 13 canonical migrations, its
preserved business data, and a current unexpired session. The native application
profile path was verified with `AuthService` and Prisma. This is local readiness,
not an HTTP/browser or testnet end-to-end result.

`EvidenceRootAnchor` is deployed on Gnosis Chiado at
`0x989a3e3a6f6294be18b93ca93ae9fa4d47a307f3` (chain ID `10200`). The receipt,
deployed code, signer getter, and nonce-derived CREATE address were checked
against the public RPC. This proves deployment only: the receipt observation is
not a finality claim.

One separately scoped, receipt-backed Chiado anchor completed successfully for
root `0x5b83ce67d74c90277c5ce24c77c88bdcca82317fe946bbc9b8dedcecf0218297` in
transaction `0xa21e65690cfb597ce7004c2f2cdb1f18f3442af22f6599a6e0b7008ee4da9332`,
block `23522938`. Receipt success records a single observed anchor only; it is
not a finality claim and does not establish full APP-11 end-to-end validation.
No credentials or other secrets are recorded here.

The public configuration reference is
[`../../../invoiceops-contracts/chiado-deployment.json`](../../../invoiceops-contracts/chiado-deployment.json).
It is not loaded by the CLI and does not establish that the backend runtime is
configured.

## Verified local database and session state

The current target is the managed local PostgreSQL database; check
`pnpm db:local:status` for its current binding. Thirteen of thirteen canonical
migrations are applied with source checksums matching. The native profile
resolved the existing user as `STUDENT` in the expected organization and
reported the session active. Check local status for current operator-only
session state; no user, organization, or session identifier, token-file path,
token contents, database password, or token hash is published. The local session
document describes safe operator handling without embedding machine-specific
metadata.

The local readiness aliases are `pnpm db:local:migrate` and
`pnpm db:local:status`. The migration helper completed after source retirement
without re-importing data. It uses the managed local target and does not
globally export a `DATABASE_URL`; do not treat this as a general shell
configuration. No batch or root was created, and the evidence/batch tables
remain empty as expected. No HTTP server, browser flow, live CLI operation,
Anvil smoke, or EVM request was performed in this reconciliation.

## Remaining preconditions for APP-11 testnet validation

The required local schema and native profile check are no longer blockers for
local readiness. The following remain outside the verified local scope:

- Any additional authorized batch/root context and, for reconciliation, a real
  authorized reservation. The completed single anchor does not authorize a new
  operation.
- A separately scoped testnet operation, explicit stop conditions, bounded
  evidence/cost ceiling, and approved transient credential channel. Local
  readiness does not authorize remote activity.
- Any signer credential needed for anchoring through an approved transient
  channel. Reconciliation must not read the signer key.
- A live application operation with its own authorization checks; the native
  profile proof is not an HTTP/CLI end-to-end validation.

Until these inputs and a separate operation scope are in place, APP-11 testnet
end-to-end validation remains pending. Do not use production credentials, pass
credentials in command arguments, persist secrets in repository files or logs,
retry an uncertain transaction, release a signer slot, or treat a transaction
hash or observed receipt as finality.

## Evidence boundary and next steps

1. Treat the receipt as an observed deployment receipt, not consensus finality.
   Explorer source verification and independent constructor-input comparison
   against the compiled artifact were not performed.
2. Provide only the missing application inputs through an approved transient
   channel and verify database isolation and current actor ACL before an EVM
   runtime is initialized.
3. Run only the separately scoped CLI operation once. Reconciliation remains
   read-only and must not read the signer key. Do not retry an uncertain send or
   release the durable signer slot.
4. Record the operation's bounded evidence and cleanup without expanding the
   claim beyond what was observed. Deployment metadata is not evidence that the
   backend runtime is configured or that APP-11 is complete.

## Cleanup evidence boundary

The specifically identified old database container and obsolete named volumes
were observed absent after cleanup; the current database was independently
rechecked afterward. The cleanup commands did not preserve an explicit
command-local Docker endpoint/context, so their execution scope and any effects
outside those observed local objects are **NOT_VERIFIED**. This does not negate
the verified current local state, but it prevents a global cleanup guarantee.
No further Docker endpoint/context inspection is part of this documentation
reconciliation.

## Local evidence boundary

The opt-in own-local Anvil/PostgreSQL smoke is separate from this testnet gate.
The previously recorded local smoke PASS establishes only that tested local
CLI/runtime flow; it cannot establish backend testnet configuration, finality,
or the APP-11 end-to-end testnet flow. The deployment record is a separate
public deployment-only proof. Ticket counts remain unchanged (InvoiceOps App
12/15; Contracts 3/7).
