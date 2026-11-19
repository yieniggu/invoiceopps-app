import type { Locator, Page } from "@playwright/test";

import {
  BUSINESS_ID_CONFLICT,
  attrs,
  rowFactAttributes,
  css,
  failureKinds,
  ids,
  inboxPath,
  loginErrorKinds,
  paths,
  resultsStates,
  screens,
} from "./contract.ts";
import {
  isCalendarDay,
  type BotRow,
  type ResultCode,
  type RowOutcome,
} from "./excel.ts";
import {
  invoiceMismatches,
  pickScope,
  redact,
  invoiceFactsFromAttributes,
  type ScopeChoice,
  type ScopeOption,
} from "./matching.ts";

/*
 * Reference RPA bot for the batch invoice journey.
 *
 * HARD RULE: it locates and decides ONLY through the selector contract
 * (docs/rpa-selector-contract.md): `getByTestId`, `#id`, `data-*` attributes,
 * `name` and option `value`s. It never matches Spanish UI copy or CSS classes.
 * The one text comparison is the organization/group NAME from the Excel
 * against the `<optgroup label>` / `<option>` text of the scope selector: that
 * is data the person owns, not interface copy. `message` in the output is the
 * UI text kept for humans and logs; no branch reads it.
 */

export interface BotOptions {
  baseUrl: string;
  rut: string;
  password: string;
  /** Retries of an uncertain attempt (same Idempotency-Key, never duplicates). */
  maxRetries?: number;
  /** First backoff; it doubles on every retry. */
  backoffMs?: number;
  loginAttempts?: number;
  rateLimitWaitMs?: number;
  /** Re-logins tolerated inside one row. */
  maxSessionRecoveries?: number;
  /** Longest wait for a submit to leave `pending` (the UI gives up at 30 s). */
  settleTimeoutMs?: number;
  log?: (line: string) => void;
  /**
   * Aborting it (Ctrl-C) stops the batch: no further rows run, the row being
   * sent ends UNCERTAIN and the rest NOT_PROCESSED (`errorKind` "interrupted").
   */
  signal?: AbortSignal;
}

/** The whole batch can not continue: every pending row is NOT_PROCESSED. */
class BatchAborted extends Error {
  readonly kind: string;
  readonly status: string;
  readonly code: string;
  constructor(kind: string, message: string, status = "", code = "") {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** An invoice found in the inbox, and the fields in which it is not the row's. */
interface Found {
  invoiceId: string;
  mismatches: string[];
}

type Seen =
  | { kind: "auth" }
  | { kind: "created"; invoiceId: string }
  | {
      kind: "failure";
      failureKind: string;
      status: string;
      code: string;
      message: string;
      field: string;
    }
  | { kind: "field"; field: string; message: string }
  | { kind: "unknown" };

const SETTLED = [
  css.screenInState(screens.invoiceCreate, "success"),
  css.screenInState(screens.invoiceCreate, "error"),
  css.screen(screens.auth),
].join(", ");

/** `error_code` when the business id exists but is not the row's invoice. */
const RECONCILE_MISMATCH = "RECONCILE_MISMATCH";

export class InvoiceBatchBot {
  private readonly page: Page;
  private readonly options: Required<Omit<BotOptions, "log" | "signal">> &
    Pick<BotOptions, "log" | "signal">;
  /** The create form is pristine (just loaded, or after «Crear otra»). */
  private formClean = false;
  private readonly scopes = new Map<string, ScopeChoice>();
  /** The row whose submit was clicked and that has no outcome yet. */
  private inFlight: { rowId: string; attempts: number } | undefined;
  private aborted: BatchAborted | undefined;
  /** Set once the batch ended early: an abandoned row must not go on. */
  private stopped = false;

  constructor(page: Page, options: BotOptions) {
    this.page = page;
    this.options = {
      maxRetries: 3,
      backoffMs: 500,
      loginAttempts: 3,
      rateLimitWaitMs: 2_000,
      maxSessionRecoveries: 2,
      settleTimeoutMs: 45_000,
      ...options,
    };
  }

  /** Why the last `run` stopped early (`undefined` when it ran to the end). */
  get abort(): { kind: string; message: string } | undefined {
    return this.aborted
      ? { kind: this.aborted.kind, message: this.aborted.message }
      : undefined;
  }

  /**
   * Processes every row; outcomes come back in input order. It never throws on
   * a failed batch: see `abort` for why it stopped.
   */
  async run(rows: readonly BotRow[]): Promise<RowOutcome[]> {
    const outcomes = new Map<string, RowOutcome>();
    this.aborted = undefined;
    this.inFlight = undefined;
    const { signal } = this.options;
    let onAbort = () => {};
    const interrupted = new Promise<"interrupted">((done) => {
      onAbort = () => done("interrupted");
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    const body = async () => {
      await this.openForm();
      for (const row of rows) {
        if (signal?.aborted) return "interrupted" as const;
        const outcome = await this.processRow(row);
        outcomes.set(row.rowId, outcome);
        this.inFlight = undefined;
        this.log(
          `${row.rowId} ${outcome.result} attempts=${outcome.attempts} ${outcome.errorCode}`.trimEnd(),
        );
      }
      await this.reconcileUncertain(rows, outcomes);
      return "done" as const;
    };
    const running = body();
    // When a signal wins the race the body is abandoned: its late failures
    // (the browser closing under it) must not surface as unhandled rejections.
    running.catch(() => undefined);
    let abort: BatchAborted | undefined;
    try {
      const ended = await Promise.race([running, interrupted]);
      if (ended === "interrupted")
        abort = new BatchAborted("interrupted", "Interrupted by a signal.");
    } catch (error) {
      // Anything unexpected (a timeout, a closed page) ends the batch like an
      // abort: the rows that finished are kept, the rest are NOT_PROCESSED.
      abort =
        error instanceof BatchAborted
          ? error
          : new BatchAborted(
              "crash",
              redact(error instanceof Error ? error.message : String(error), [
                this.options.password,
                this.options.rut,
              ]),
            );
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    // The body may still be running after an interruption: freeze the batch.
    this.stopped = abort !== undefined;
    const inFlight = this.currentInFlight();
    this.aborted = abort;
    if (abort) this.log(`batch aborted: ${abort.kind}`);
    return rows.map((row) => {
      const done = outcomes.get(row.rowId);
      if (done) return done;
      // The submit was clicked and no outcome was recorded: the invoice may
      // exist, so the row is UNCERTAIN, never NOT_PROCESSED. No reconciliation
      // after a crash: the page can not be trusted.
      if (abort && inFlight?.rowId === row.rowId)
        return this.outcome(row, "UNCERTAIN", {
          errorKind: abort.kind,
          errorStatus: abort.status,
          errorCode: abort.code,
          message: abort.message,
          attempts: inFlight.attempts,
        });
      return this.outcome(row, "NOT_PROCESSED", {
        errorKind: abort?.kind ?? "aborted",
        errorStatus: abort?.status,
        errorCode: abort?.code,
        message: abort?.message,
      });
    });
  }

  /** Read through a method: the body mutates it, TypeScript can not see that. */
  private currentInFlight() {
    return this.inFlight;
  }

  // ---------------------------------------------------------------- session

  private url(path: string) {
    return new URL(path, this.options.baseUrl).toString();
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  /** First key whose selector is present (map order breaks ties). */
  private async observe(
    selectors: Record<string, string>,
    timeout = 20_000,
  ): Promise<string> {
    const handle = await this.page.waitForFunction(
      (map) => {
        for (const [key, selector] of Object.entries(map))
          if (document.querySelector(selector)) return key;
        return false;
      },
      selectors,
      { timeout },
    );
    return (await handle.jsonValue()) as string;
  }

  /** Signs in from the auth screen; credentials failures abort the batch. */
  private async login(): Promise<void> {
    const { loginAttempts, rateLimitWaitMs, backoffMs } = this.options;
    for (let attempt = 1; ; attempt += 1) {
      await this.page.getByTestId(ids.loginRut).fill(this.options.rut);
      await this.page
        .getByTestId(ids.loginPassword)
        .fill(this.options.password);
      await this.page.getByTestId(ids.loginSubmit).click();
      // The client validates the RUT and the password before sending: its
      // field messages (never empty once shown) end the wait just like the
      // server's `login-error`, instead of timing out.
      await this.page.waitForFunction(
        ({ auth, error, fieldErrors }) =>
          !document.querySelector(auth) ||
          document.querySelector(error) ||
          fieldErrors.some(
            (selector) =>
              (document.querySelector(selector)?.textContent ?? "").trim() !==
              "",
          ),
        {
          auth: css.screen(screens.auth),
          error: css.testId(ids.loginError),
          fieldErrors: [ids.loginRut, ids.loginPassword].map(css.fieldError),
        },
        { timeout: 20_000 },
      );
      const error = this.page.getByTestId(ids.loginError);
      if ((await error.count()) === 0) {
        if ((await this.page.locator(css.screen(screens.auth)).count()) === 0)
          return;
        const field = await this.loginFieldError();
        throw new BatchAborted(
          "credentials",
          field || "The login form rejected the RUT or the password.",
        );
      }
      const kind = (await error.getAttribute(attrs.errorKind)) ?? "";
      const status = (await error.getAttribute(attrs.errorStatus)) ?? "";
      const code = (await error.getAttribute(attrs.errorCode)) ?? "";
      const message = ((await error.textContent()) ?? "").trim();
      const transient =
        kind === loginErrorKinds.rateLimited ||
        kind === loginErrorKinds.network ||
        kind === loginErrorKinds.unknown;
      if (!transient || attempt >= loginAttempts)
        throw new BatchAborted(kind || "login", message, status, code);
      await this.page.waitForTimeout(
        kind === loginErrorKinds.rateLimited
          ? rateLimitWaitMs
          : backoffMs * attempt,
      );
    }
  }

  /** The text of the first login field message that is showing, if any. */
  private async loginFieldError(): Promise<string> {
    for (const id of [ids.loginRut, ids.loginPassword]) {
      const text = (
        (await this.page.locator(css.fieldError(id)).textContent()) ?? ""
      ).trim();
      if (text !== "") return text;
    }
    return "";
  }

  /** Opens /invoices/new signed in and verifies the screen; aborts on forbidden. */
  private async openForm(): Promise<void> {
    for (let pass = 0; pass < 3; pass += 1) {
      await this.page.goto(this.url(paths.newInvoice));
      const seen = await this.observe({
        auth: css.screen(screens.auth),
        onboarding: css.screen(screens.onboarding),
        forbidden: css.testId(ids.forbidden),
        form: css.testId(ids.invoiceForm),
      });
      if (seen === "form") {
        this.formClean = true;
        return;
      }
      if (seen === "auth") {
        await this.login();
        continue;
      }
      if (seen === "onboarding")
        throw new BatchAborted(
          "onboarding",
          "The account must finish onboarding before a bot can run.",
        );
      throw new BatchAborted(
        "forbidden",
        "The account can not create invoices.",
      );
    }
    throw new BatchAborted("session", "Could not open the create screen.");
  }

  // -------------------------------------------------------------------- row

  private async processRow(row: BotRow): Promise<RowOutcome> {
    let attempts = 0;
    let retried = false;
    let uncertainSeen = false;
    let recoveries = 0;
    const result = (
      code: ResultCode,
      extra: Partial<RowOutcome> = {},
    ): RowOutcome => this.outcome(row, code, { attempts, ...extra });

    for (;;) {
      if (this.stopped) throw new BatchAborted("interrupted", "Stopped.");
      if (!this.formClean) await this.openForm();
      const pick = await this.resolveScope(row);
      if (pick.kind === "ambiguous")
        return result("SKIPPED", {
          errorKind: "scope",
          errorCode: "ORGANIZATION_AMBIGUOUS",
          message:
            "The organization is not unique: the row has none and the account is offered several, or several offered organizations share its name.",
        });
      if (pick.kind === "missing")
        return result("SKIPPED", {
          errorKind: "scope",
          errorCode: "SCOPE_NOT_AVAILABLE",
          message: "The organization or group is not offered to this account.",
        });
      const choice = pick.choice;
      this.scopes.set(row.rowId, choice);
      if (!(await this.statusOffered(row.status)))
        return result("SKIPPED", {
          errorKind: "input",
          errorCode: "STATUS_NOT_AVAILABLE",
          message: `Unknown status value "${row.status}".`,
        });

      await this.fill(row, choice);
      attempts += 1;
      // From the click on, the invoice may exist whatever happens next.
      this.inFlight = { rowId: row.rowId, attempts };
      await this.page.getByTestId(ids.submit).click();
      let seen = await this.settle();

      let retries = 0;
      while (
        seen.kind === "failure" &&
        seen.failureKind === failureKinds.uncertain
      ) {
        uncertainSeen = true;
        if (retries >= this.options.maxRetries) break;
        await this.page.waitForTimeout(this.options.backoffMs * 2 ** retries);
        retries += 1;
        retried = true;
        attempts += 1;
        this.inFlight = { rowId: row.rowId, attempts };
        seen = await this.retry();
      }

      switch (seen.kind) {
        case "created": {
          await this.page.getByTestId(ids.another).click();
          await this.page.getByTestId(ids.invoiceForm).waitFor();
          this.formClean = true;
          return result(retried ? "CREATED_AFTER_RETRY" : "CREATED", {
            invoiceId: seen.invoiceId,
          });
        }
        case "auth": {
          this.formClean = false;
          recoveries += 1;
          if (recoveries > this.options.maxSessionRecoveries)
            return result("UNCERTAIN", {
              errorKind: "session",
              message: "The session kept expiring while sending the row.",
            });
          await this.openForm();
          // The request may have been processed before the session ended, so a
          // later BUSINESS_ID_CONFLICT must be reconciled too.
          uncertainSeen = true;
          const found = await this.lookup(row, choice);
          if (found?.mismatches.length === 0)
            return result("CREATED_RECONCILED", { invoiceId: found.invoiceId });
          if (found) return result("REJECTED", this.mismatchDetail(found));
          continue;
        }
        case "failure": {
          this.formClean = false;
          const detail = {
            errorStatus: seen.status,
            errorCode: seen.code,
            field: seen.field,
            message: seen.message,
          };
          if (seen.failureKind === failureKinds.burned)
            return result("MANUAL_REVIEW", { errorKind: "burned", ...detail });
          if (seen.failureKind === failureKinds.uncertain)
            return result("UNCERTAIN", { errorKind: "uncertain", ...detail });
          if (seen.code === BUSINESS_ID_CONFLICT && uncertainSeen) {
            // An earlier uncertain attempt probably created it.
            const found = await this.lookup(row, choice);
            if (found?.mismatches.length === 0)
              return result("CREATED_RECONCILED", {
                invoiceId: found.invoiceId,
              });
            if (found) return result("REJECTED", this.mismatchDetail(found));
          }
          return result("REJECTED", { errorKind: "rejected", ...detail });
        }
        case "field":
          this.formClean = false;
          return result("REJECTED_FIELD", {
            errorKind: "field",
            field: seen.field,
            message: seen.message,
          });
        default:
          this.formClean = false;
          return result("MANUAL_REVIEW", {
            errorKind: "unrecognized",
            message:
              "The screen settled in a state the contract does not list.",
          });
      }
    }
  }

  /** The scope option the row asks for (see `pickScope`). */
  private async resolveScope(row: BotRow) {
    const options: ScopeOption[] = await this.page
      .getByTestId(ids.scope)
      .evaluate((select: HTMLSelectElement) =>
        Array.from(select.options).map((option) => ({
          value: option.value,
          text: option.text.trim(),
          organization:
            option.parentElement instanceof HTMLOptGroupElement
              ? option.parentElement.label.trim()
              : "",
        })),
      );
    return pickScope(options, row.organization, row.group);
  }

  private async statusOffered(status: string): Promise<boolean> {
    if (status === "") return true;
    const values = await this.page
      .getByTestId(ids.businessStatus)
      .evaluate((select: HTMLSelectElement) =>
        Array.from(select.options).map((option) => option.value),
      );
    return values.includes(status);
  }

  private async fill(row: BotRow, choice: ScopeChoice): Promise<void> {
    const page = this.page;
    await page.getByTestId(ids.scope).selectOption(choice.value);
    await page.getByTestId(ids.businessId).fill(row.businessId);
    await page.getByTestId(ids.supplierName).fill(row.supplierName);
    await page.getByTestId(ids.amount).fill(row.amountPesos);
    if (row.status !== "")
      await page.getByTestId(ids.businessStatus).selectOption(row.status);
    // A date input only takes real ISO days (`fill` throws "Malformed value" on
    // 2026-02-31); anything else leaves it empty so the UI validation reports
    // that field and only that row.
    const day = (value: string) => (isCalendarDay(value) ? value : "");
    await page.getByTestId(ids.issuedOn).fill(day(row.issuedOn));
    await page.getByTestId(ids.dueOn).fill(day(row.dueOn));
  }

  /** Waits for `data-state` to leave `pending` (or for the auth screen). */
  private async settle(): Promise<Seen> {
    await this.page
      .locator(SETTLED)
      .first()
      .waitFor({ state: "attached", timeout: this.options.settleTimeoutMs });
    return this.read();
  }

  /** «Reintentar»: the old failure stays on screen, so wait for `pending` first. */
  private async retry(): Promise<Seen> {
    const pending = this.page
      .locator(css.screenInState(screens.invoiceCreate, "pending"))
      .first()
      .waitFor({ state: "attached", timeout: 3_000 })
      .catch(() => undefined);
    await this.page.getByTestId(ids.retry).click();
    await pending;
    return this.settle();
  }

  private async read(): Promise<Seen> {
    const page = this.page;
    if ((await page.locator(css.screen(screens.auth)).count()) > 0)
      return { kind: "auth" };
    const created = page.getByTestId(ids.created);
    if ((await created.count()) > 0)
      return {
        kind: "created",
        invoiceId: (await created.getAttribute(attrs.invoiceId)) ?? "",
      };
    const field = await this.readField();
    const failure = page.getByTestId(ids.failure);
    if ((await failure.count()) > 0)
      return {
        kind: "failure",
        failureKind: (await failure.getAttribute(attrs.failureKind)) ?? "",
        status: (await failure.getAttribute(attrs.errorStatus)) ?? "",
        code: (await failure.getAttribute(attrs.errorCode)) ?? "",
        message: ((await failure.textContent()) ?? "").trim(),
        field: field?.field ?? "",
      };
    if (field) return { kind: "field", ...field };
    return { kind: "unknown" };
  }

  /** `aria-invalid` control, its `<id>-error` text and `data-field`. */
  private async readField(): Promise<
    { field: string; message: string } | undefined
  > {
    const invalid = this.page
      .locator(`${css.testId(ids.invoiceForm)} [aria-invalid="true"]`)
      .first();
    if ((await invalid.count()) === 0) return undefined;
    const id = await invalid.getAttribute("id");
    if (!id) return undefined;
    const error = this.page.locator(css.fieldError(id));
    return {
      field: (await error.getAttribute(attrs.field)) ?? "",
      message: ((await error.textContent()) ?? "").trim(),
    };
  }

  // --------------------------------------------------------- reconciliation

  /**
   * The invoice of the inbox under the row's business id, with the fields in
   * which it differs from the row: an id left by an earlier run is not proof
   * that THIS row was created.
   */
  private async lookup(
    row: BotRow,
    scope: ScopeChoice,
  ): Promise<Found | undefined> {
    this.formClean = false;
    const { businessId } = row;
    if (businessId === "") return undefined;
    const rowSelector = css.invoiceRow(businessId);
    for (let pass = 0; pass < 3; pass += 1) {
      await this.page.goto(this.url(inboxPath(scope, businessId)));
      const seen = await this.observe({
        auth: css.screen(screens.auth),
        row: rowSelector,
        inbox: css.screen(screens.invoices),
      });
      if (seen === "auth") {
        await this.login();
        continue;
      }
      // `invoices-results` turns «ready» only once the requested page (rows or
      // empty state) is on screen and nothing is being fetched.
      const results = this.page.locator(
        `[data-testid="${ids.invoicesResults}"]`,
      );
      await results
        .and(
          this.page.locator(
            `[${attrs.state}="${resultsStates.ready}"], [${attrs.state}="${resultsStates.error}"]`,
          ),
        )
        .waitFor({ state: "attached", timeout: 20_000 });
      if ((await results.getAttribute(attrs.state)) === resultsStates.error)
        continue;
      const found = this.page.locator(rowSelector).first();
      if ((await found.count()) === 0) return undefined;
      const invoiceId = (await found.getAttribute(attrs.invoiceId)) ?? "";
      if (invoiceId === "") return undefined;
      return {
        invoiceId,
        mismatches: await this.compare(row, scope, found),
      };
    }
    return undefined;
  }

  /**
   * Compares the inbox row with the CSV row using only its `data-*` anchors.
   * `unverified` when an anchor is missing: that is never proof of a match.
   */
  private async compare(
    row: BotRow,
    scope: ScopeChoice,
    found: Locator,
  ): Promise<string[]> {
    try {
      const read: Record<string, string | null> = {};
      for (const name of rowFactAttributes)
        read[name] = await found.getAttribute(name);
      const facts = invoiceFactsFromAttributes(read);
      if (!facts) return ["unverified"];
      return invoiceMismatches(
        {
          businessId: row.businessId,
          supplierName: row.supplierName,
          amountPesos: row.amountPesos,
          issuedOn: row.issuedOn,
          dueOn: row.dueOn,
          organizationId: scope.organizationId,
          groupId: scope.groupId ?? null,
        },
        facts,
      );
    } catch {
      return ["unverified"];
    }
  }

  private mismatchDetail(found: Found): Partial<RowOutcome> {
    return {
      errorKind: "reconcile",
      errorCode: RECONCILE_MISMATCH,
      message: `The business id exists (${found.invoiceId}) but differs in: ${found.mismatches.join(", ")}.`,
    };
  }

  private async reconcileUncertain(
    rows: readonly BotRow[],
    outcomes: Map<string, RowOutcome>,
  ): Promise<void> {
    for (const row of rows) {
      const outcome = outcomes.get(row.rowId);
      const scope = this.scopes.get(row.rowId);
      if (outcome?.result !== "UNCERTAIN" || !scope) continue;
      const found = await this.lookup(row, scope);
      if (!found) continue;
      if (found.mismatches.length > 0) {
        // Somebody else's invoice (or one the row anchors can not confirm): the row
        // stays UNCERTAIN, with the reason.
        outcomes.set(row.rowId, { ...outcome, ...this.mismatchDetail(found) });
        continue;
      }
      outcomes.set(
        row.rowId,
        this.outcome(row, "CREATED_RECONCILED", {
          invoiceId: found.invoiceId,
          attempts: outcome.attempts,
        }),
      );
      this.log(`${row.rowId} reconciled`);
    }
  }

  private outcome(
    row: BotRow,
    result: ResultCode,
    extra: Partial<RowOutcome> = {},
  ): RowOutcome {
    return {
      rowId: row.rowId,
      result,
      invoiceId: "",
      errorKind: "",
      errorStatus: "",
      errorCode: "",
      field: "",
      message: "",
      attempts: 0,
      finishedAt: new Date().toISOString(),
      ...Object.fromEntries(
        Object.entries(extra).filter(([, value]) => value !== undefined),
      ),
    };
  }
}
