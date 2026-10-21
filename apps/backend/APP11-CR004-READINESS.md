# APP-11 CR-004 testnet readiness follow-up

## Current disposition

**2026-10-20: APP-11 CLOSED / COMPLETED_VALIDATED; CR-004 RESOLVED_VERIFIED**, scoped
to the original five acceptance criteria and receipt observation/native integration,
not production readiness or consensus finality. This supersedes the pending
preconditions and statuses in the dated history below, without reclassifying old
attempts. [Five-criterion matrix and closure](../../../dev/tickets/Implementado.md#app-11cr-004--cierre-documental-final-2026-10-20).

The 2026-10-14 anchor succeeded; its prepared transaction was persisted before
exactly one broadcast. On 2026-10-20, the authorized recovery recreated only
the absent original managed local database container using cached PostgreSQL
17.11, the original volume, and a loopback binding. PostgreSQL recognized the
existing database and skipped initialization; 13/13 migration checksums matched
source. No migrations, reset, or restore ran. The database was left **RUNNING** on
its original volume; normal PostgreSQL writes mean this was not physically
read-only. Only private operational recovery metadata changed, not project
environment or source files.

The existing active session, original actor ACL through native `AuthService`, and
reconstructed batch integrity passed. One native `runEvidenceAnchorCli`
`reconcile` operation through a temporary external `tsx` adapter exited **0**:
`kind=observedSuccess`, `reason=matched`, `receiptStatus=success`, block **23522938**.
The transaction, receipt, canonical block, and event matched. Durable observations
changed **0 → 1**, linked to the full prepared-transaction identity; reservations,
signer slots, and prepared transactions each remained **1 → 1**. The native CLI
received an allowlisted environment without the signer private key. However, the
historical adapter transiently read and parsed the entire environment file,
including a nonempty signer key, before discarding parsed properties. The prior
claim that the reconciliation process never read the key was incorrect; deleting
properties does not prove memory erasure. No new signing, sending, deployment,
funding, or installation occurred. The signer slot remains locked, with no release or
additional cleanup authorized.

**APP11-CR011 correction (2026-10-21):** historical AC05 was only partially met:
the native CLI key-free product contract is supported, but the stricter
process-isolation guarantee was not met and is neither retroactively satisfied
nor implicitly accepted. The functional receipt proof, CR-004 closure, and five
original criteria remain valid. There is no evidence of key disclosure, signing,
or broadcast from this deviation; key rotation is not required by this finding.
The future external adapter no longer loads environment files and rejects any
inherited signer-key variable, even empty, before dependency loading or access
to DB/RPC. Its launcher forwards only explicitly supplied allowlisted variables;
neither helper loads files or imports an environment-audit helper. A separately
authorized operator must supply required variables through an approved channel,
not by sourcing the full environment file. Existing identity, session/ACL, and
zero-observation guards remain; the historical observation already exists, so
replay must stop without reconciliation. Synthetic verification is not a new
operational run and cannot establish historical process isolation.

Public evidence: Chiado **10200**, contract
`0x989a3e3a6f6294be18b93ca93ae9fa4d47a307f3`, root
`0x5b83ce67d74c90277c5ce24c77c88bdcca82317fe946bbc9b8dedcecf0218297`, transaction
`0xa21e65690cfb597ce7004c2f2cdb1f18f3442af22f6599a6e0b7008ee4da9332`.
The historical anchor and current native reconciliation jointly satisfy the
testnet criterion through environment configuration; the original criteria did
not require that historical anchor to be CLI-only.

Prior local evidence remains S1 **89/89 across eight files** (its repeated control
is not additional unique coverage) and final S2 **65/65**, exit **0**, **39.05 s**
(64 SQL tests across seven suites plus one real Anvil CLI smoke), with own-resource
cleanup verified. No suites or operations were repeated for this documentation
edit. Earlier environment failures remain in the linked ledger; the temporary
no-install adapter and `node --import tsx` preserved sandbox and assertions, not
an application bug fix.

Observed receipt success is not finality. App server, browser, and full-stack
behavior were not freshly verified; Explorer source verification and production
certification are not claimed. This per-operation Chiado authorization does not
change the global remote-deployment deferral or authorize retries/signer reuse.
Only APP-11 increments App to **13/15 (86.7%)**; Contracts stays **3/7** and no
other ticket closes. Next is APP-12 planning only, with APP-03 through APP-11
satisfied; implementation is not authorized.

## Historical readiness snapshot (2026-10-13; superseded on 2026-10-20)

All remaining sections preserve the earlier evidence and pending instructions as
history, not current database contents, ticket status, or authorization to act.

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
