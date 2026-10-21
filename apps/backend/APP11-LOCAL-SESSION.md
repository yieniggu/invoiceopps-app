# APP-11 local session and database selection

> **Snapshot notice (2026-10-21):** the 2026-10-13 state and pending-testnet
> disposition below are historical, superseded for current APP-11 status by
> [Current disposition](APP11-CR004-READINESS.md#current-disposition).
> Current runtime, database, and session readiness still require local checks;
> this snapshot does not establish that a session remains valid or authorize operations.

This document tracks local database and session readiness only. It does **not** claim APP-11 backend anchoring, reconciliation, testnet execution, or overall completion.

## Current verified local state — 2026-10-13

| Item                         | Verified value                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Managed PostgreSQL target    | Check `pnpm db:local:status`                                                                                                  |
| Network scope                | Loopback only; check local status for the current binding                                                                     |
| PostgreSQL version           | `17.11`                                                                                                                       |
| Database / role              | `invoiceops` / `invoiceops`                                                                                                   |
| Canonical migrations         | 13 successful migrations; all current source checksums match                                                                  |
| Current data                 | Existing local development data and session are retained; inspect local status for private details                            |
| Native profile proof         | Passed against the current database using the real `AuthService` and current owned session                                    |
| Current session              | Locally owned session; typically valid for 2 hours. Check `pnpm db:local:status` for current state.                           |
| Protected token file         | Keep outside Git in the operator-owned local state directory; resolve its current location locally.                           |
| Current verified full backup | Protected operator-owned artifact outside the repository; verify its local record without publishing its path or fingerprint. |

The verified native profile was active with the expected `STUDENT` membership in the designated local organization. The token file and private local manifest remain outside Git with mode `0600` files and a mode `0700` state directory. Never copy token contents, database credentials, user, organization, or session identifiers, token hashes, backup paths or fingerprints, or row fingerprints into documentation, shell history, or logs. The full backup is a protected local artifact, not a repository file.

The prior source database container and two obsolete named volumes were observed absent after cleanup. The current managed database, its volume, current session, private metadata, and newest verified backup were retained. Stopped legacy app containers were left untouched. This records observed target objects, not a global Docker cleanup guarantee.

## Operator quick check

From the application root, inspect current local readiness before using a session:

```bash
pnpm db:local:status
```

Use the status output only locally to identify the current session and its
operator-owned token file. A generic shell helper can refer to that file without
adding an application setting or printing its contents:

```bash
LOCAL_STATE_DIR="<LOCAL_STATE_DIR>"
SESSION_FILE="$LOCAL_STATE_DIR/session-<SESSION_ID>/session-token.txt"
test -f "$SESSION_FILE"
```

Replace `<SESSION_ID>` locally using the status output. Keep the file outside
Git, owned by the operator, with mode `0600`; do not copy the token value into
commands, logs, or shared output. When invoking a separately authorized local
operator command, load only from this file using shell syntax such as
`APP_SESSION_TOKEN="$(<"$SESSION_FILE")" <authorized-command>`. `LOCAL_STATE_DIR`
and `SESSION_FILE` are shell-only helper variables, not supported application
configuration. Local sessions are short-lived (typically two hours); check
status again rather than relying on a copied expiry timestamp.

Previously expired local sessions were removed while the current session remained unexpired. The current full backup was restored into an owned scratch database, where all 13 migrations, business row counts, validated constraints, and the native AuthService profile were checked. That scratch database was then dropped. A post-source-removal `pnpm db:local:migrate` completed successfully without re-importing from the source. The native profile check confirms the application service and Prisma path; no HTTP server or browser login was exercised.

**Disposition: `READY_LOCAL_WITH_FOLLOWUP`.** The historical intermittent process-group diagnostic remains a follow-up with unknown cause; no functional fix or baseline classification is claimed. **Historical implementation results—not rerun for this documentation-only update:** focused helper/schema checks, independent SQL checks, unit suite (262/262 across 29 files), source metadata checks, lint, typecheck, formatting, and diff checks were recorded as passing. No live HTTP server, browser, public-network request, new batch/root, or new application data was created. Full APP-11/CR-004 testnet end-to-end validation remains pending: the deployment record alone does not prove the application flow, so global ticket counts remain unchanged.

### Cleanup provenance follow-up

The exact post-cleanup local state listed above was independently rechecked, including the current 13-migration database and absence of the specifically named old container and volumes. However, the cleanup actor used bare Docker commands without recording an explicit command-local endpoint/context. The effective endpoint/context and whether those commands were confined to the authorized local daemon are therefore **NOT_VERIFIED**. Do not infer a global cleanup guarantee or foreign-resource impact from the local observations; this is an execution-scope evidence gap, not a claim that foreign resources were changed. No further Docker endpoint/context inspection is part of this reconciliation.

## Historical rollout snapshot (superseded; not current state)

The sections below preserve the earlier rollout record. Their database selection, migration count, session, and backup statements describe the historical state at that time; use the current-state section above for today's local target.

### Historical selected database — superseded

| Item                          | Verified value                                          |
| ----------------------------- | ------------------------------------------------------- |
| Docker Compose project        | Previous local Compose target; name omitted             |
| PostgreSQL container          | Previous local database container; name omitted         |
| Public local binding          | Previous loopback binding; exact local port omitted     |
| Database / role               | `invoiceops` / `invoiceops` (no password recorded here) |
| PostgreSQL                    | `17.11`                                                 |
| Persistent volume             | Previous local named volume (retained at that time)     |
| Applied successful migrations | 8 of the 13 currently present in source                 |
| Latest applied migration      | `20260927213500_add_model_inference_audit`              |

The migration comparison originally selected this database over an older local Compose target: that instance had only two successful migrations through `20260910120000_add_authentication`, no application users, sessions, or invoices, and no public host port. The old PostgreSQL container was removed after a private custom-format backup was created and catalog-checked. At that point its named volume was retained; that volume has since been removed after the later full restore verification documented above. No repository directory or source was removed.

### Historical migration drift and schema gap — superseded

At the time of this historical snapshot, the selected database was not fully current with the checked-out schema. Five migrations remained unapplied:

1. `20261008060000_add_evidence_persistence`
2. `20261011000000_add_evidence_anchor_reservations`
3. `20261011010000_add_evidence_prepared_transactions`
4. `20261011020000_add_evidence_anchor_observations`
5. `20261013000000_correct_model_inference_snapshot_guard`

At that time, `EvidenceRecord`, `EvidenceBatch`, reservation, prepared-transaction, and observation tables were absent. Seven applied migration checksums matched their source; the latest applied migration, `20260927213500_add_model_inference_audit`, did not.

After explicit authorization for the earlier local rollout, a private custom-format backup of the selected database was catalog-checked and restored into a uniquely named scratch database. That historical restore preserved its observed counts and eight successful migration rows. The older backup was removed only after the current 13-migration full backup was restored and verified; the selected `invoiceops` database was not replaced or dropped.

The checksum drift is not safe to treat as formatting-only. Comparing the checked-out SQL with PostgreSQL's live `DecisionEvent_model_inference_snapshot_check` definition showed semantic differences: the current SQL uses `COALESCE(..., FALSE)` and requires model snapshot fields to be null for `LOCAL_DEMONSTRATION`, while the live constraint definition lacks those protections. The live source check constraint is validated and the existing decision row passes the current source predicate, but that does not establish equivalence for all future values.

The available local Git source history was searched with `git log --all --reflog --follow` and `git log --all --reflog -S'COALESCE(('` for this migration; both returned only one local source revision. Its migration file matched the current checked-out file, while `_prisma_migrations` recorded a different checksum. No matching historical SQL was recovered, and no fetch was performed. The original applied migration file remains untouched, and its checksum row will not be edited to conceal drift.

Instead, migration `20261013000000_correct_model_inference_snapshot_guard` re-establishes the current strict audit constraint in one `ALTER TABLE` statement. It changes no Prisma model, user, role, or business row. The owned PostgreSQL integration gate simulates the observed weaker live constraint, proves that both previously accepted invalid cases exist before correction, applies migrations 9–13 through Prisma, then proves both cases are rejected while the legacy event remains intact. This yields 13 source migrations without checksum repair; the selected database still had eight successful rows at the time of this historical snapshot.

At that historical point, the Prisma CLI rollout and native authentication check were blocked: TCP to the then-selected binding required a password, and the fallback candidate was rejected. No protected environment file or Docker `Config.Env` was inspected to obtain credentials, and no database auth settings were weakened. The selected database had eight successful migrations at that time; this statement is superseded by the current-state section above.

### Historical issued local session — expired and removed

| Item                | Value                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Issuance            | Local administrative session-row issuance; **not** password login                                 |
| Existing user       | Existing local user; identifier omitted                                                           |
| Existing membership | Designated local organization, role `STUDENT`; names and identifiers omitted                      |
| Session             | Expired historical local session; identifier and exact timestamps omitted                         |
| Secret artifact     | Protected temporary file outside Git; expired and removed after the later verified backup restore |

The token was 32 random bytes encoded as base64url; the database stored only the application's SHA-256/base64 token hash. The raw token and token hash were not recorded in Git, database output, or this document. This historical session expired and its protected token artifact has since been removed. Use the current operator quick check above; it resolves current local state rather than relying on expired historical identifiers or timestamps.

### Historical verification boundary and next step — superseded

The insert and follow-up SQL check confirmed the new row's ID, user foreign key, future expiry, and the precomputed application-compatible SHA-256/base64 hash without returning the hash. The database counts changed only from two to three session rows; users (1), invoices (2), organizations (1), memberships (1), decision events (1), and business policies (1) were unchanged. The two prior sessions were expired and left intact.

The backend container was not started, because its startup path may apply migrations. Therefore a live `createAuthService().getProfile()` / HTTP `/profile` verification is **NOT_VERIFIED**; the SQL check is not a substitute for runtime authentication. `DATABASE_URL` was not read from protected configuration. No batch/reservation exists in the available schema/data, so the session does not prove an APP-11 authorized batch context. No EVM call, anchor, reconciliation, or transaction was performed; the Chiado deployment metadata remains deployment-only evidence, not backend runtime configuration or finality.

At that historical point, the next steps were to resolve the pending migrations and checksum drift, establish a real batch/owner context, and verify the profile through the normal application runtime. This historical note does not mark APP-11 complete or change global ticket counts.
