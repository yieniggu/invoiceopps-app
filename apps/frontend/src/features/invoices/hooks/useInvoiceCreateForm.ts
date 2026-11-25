import { useEffect, useRef, useState, type FormEvent } from "react";

import { useCreateInvoice } from "./useCreateInvoice";
import {
  describeCreateFailure,
  type CreateFailure,
} from "../invoiceCreateOutcome";
import type { CreateScopeOption } from "../invoiceCreateScopes";
import {
  draftToInput,
  DRAFT_FIELDS,
  validateDraft,
  type DraftErrors,
  type DraftField,
  type InvoiceDraft,
} from "../invoiceDraft";
import { todayCivilDate } from "../invoicePresentation";
import type { CreatedInvoice, InvoiceCreateInput } from "../types";

/**
 * One logical attempt to create an invoice: its key is generated at its first
 * submit and travels with its body until it succeeds or is refused.
 * - inflight: a request is out; further submits are ignored.
 * - uncertain: no verdict (network, timeout, 503): the same key and body may
 *   be sent again, anything else is a NEW operation the person must confirm.
 * - burned: the API refused the key for this request: only a new operation.
 */
interface Attempt {
  key: string;
  input: InvoiceCreateInput;
  fingerprint: string;
  status: "inflight" | "uncertain" | "burned";
}

export type InvoiceCreateState = "idle" | "pending" | "success" | "error";

export interface CreatedResult {
  invoice: CreatedInvoice;
  scope: CreateScopeOption;
}

const emptyDraft = (): InvoiceDraft => ({
  businessId: "",
  supplierName: "",
  amount: "",
  issuedOn: todayCivilDate(),
  dueOn: "",
  businessStatus: "PENDING",
});

/** `crypto.randomUUID` needs a secure context; the fallback is just as random. */
function newIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * State, validation and submission of the create-invoice form. The idempotency
 * key lives in a ref of the logical attempt, never in render or an effect.
 */
export function useInvoiceCreateForm(options: readonly CreateScopeOption[]) {
  const create = useCreateInvoice();
  const [values, setValues] = useState(emptyDraft);
  const [scopeValue, setScopeValue] = useState<string>();
  const [errors, setErrors] = useState<DraftErrors>({});
  const [failure, setFailure] = useState<CreateFailure>();
  const [confirming, setConfirming] = useState(false);
  // Counts every time the confirmation is asked for, so the screen can move
  // focus to it again when it is already shown (a second spent key).
  const [confirmationRequests, setConfirmationRequests] = useState(0);
  const [created, setCreated] = useState<CreatedResult>();
  const [uncertain, setUncertain] = useState(false);
  // A failure was shown for this operation: the screen keeps its alert slot
  // while the next request is out, so the layout does not jump.
  const [afterFailure, setAfterFailure] = useState(false);
  const [restarts, setRestarts] = useState(0);
  const attempt = useRef<Attempt | null>(null);
  const fields = useRef<Partial<Record<DraftField, HTMLElement>>>({});

  // A scope that is no longer offered gives way to the first one.
  const scope = options.find(({ value }) => value === scopeValue) ?? options[0];

  const register = (field: DraftField) => (element: HTMLElement | null) => {
    if (element) fields.current[field] = element;
    else delete fields.current[field];
  };

  const change = <K extends keyof InvoiceDraft>(
    field: K,
    value: InvoiceDraft[K],
  ) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (field in errors) {
      const rest = { ...errors };
      delete rest[field as DraftField];
      setErrors(rest);
    }
  };

  const askConfirmation = () => {
    setConfirming(true);
    setConfirmationRequests((count) => count + 1);
  };

  const send = (next: Attempt) => {
    attempt.current = { ...next, status: "inflight" };
    // The previous failure is dropped now, so nothing stale (message, kind)
    // is exposed while the new request is out. «Reintentar» and the
    // confirmation stay mounted (their buttons are `aria-disabled`):
    // unmounting the one the person just activated would drop focus to the
    // page. The outcome below replaces them.
    setFailure(undefined);
    create.mutate(
      { input: next.input, idempotencyKey: next.key },
      {
        onSuccess: (invoice) => {
          attempt.current = null;
          setAfterFailure(false);
          setCreated({ invoice, scope });
        },
        onError: (error) => {
          const result = describeCreateFailure(error);
          setFailure(result);
          setAfterFailure(true);
          setUncertain(result.kind === "uncertain");
          if (result.kind === "burned") askConfirmation();
          else setConfirming(false);
          if (result.kind === "rejected") {
            attempt.current = null;
            if (result.field) {
              setErrors({ [result.field]: result.message });
              fields.current[result.field]?.focus();
            }
            return;
          }
          attempt.current = { ...next, status: result.kind };
        },
      },
    );
  };

  const run = (confirmed: boolean) => {
    // A second click or Enter while the first request is out shares it.
    if (attempt.current?.status === "inflight" || !scope) return;
    const found = validateDraft(values);
    const first = DRAFT_FIELDS.find((field) => found[field]);
    setErrors(found);
    if (first) {
      fields.current[first]?.focus();
      return;
    }
    const input = draftToInput(values, scope);
    const fingerprint = JSON.stringify(input);
    const current = attempt.current;
    // Different data (or a spent key) after an attempt without verdict: the
    // old one may still have created its invoice, so a new operation needs a
    // yes from the person.
    if (
      !confirmed &&
      current &&
      (current.status === "burned" || current.fingerprint !== fingerprint)
    ) {
      askConfirmation();
      return;
    }
    // Only now, with valid data, is the old attempt given up: a confirmation
    // refused by validation leaves it (and its key) intact.
    send(
      confirmed || !current
        ? {
            key: newIdempotencyKey(),
            input,
            fingerprint,
            status: "inflight",
          }
        : current,
    );
  };

  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    run(false);
  };

  const confirmNewOperation = () => run(true);

  const restart = () => {
    attempt.current = null;
    create.reset();
    setValues(emptyDraft());
    setErrors({});
    setFailure(undefined);
    setConfirming(false);
    setUncertain(false);
    setAfterFailure(false);
    setCreated(undefined);
    setRestarts((count) => count + 1);
  };

  // «Crear otra» replaces the form: focus goes back to its first field.
  useEffect(() => {
    if (restarts > 0) fields.current.businessId?.focus();
  }, [restarts]);

  // One readable state for automation (docs/rpa-selector-contract.md §2.2).
  const state: InvoiceCreateState = create.isPending
    ? "pending"
    : created
      ? "success"
      : failure || Object.keys(errors).length > 0
        ? "error"
        : "idle";

  return {
    state,
    values,
    change,
    scope,
    selectScope: setScopeValue,
    // Changing the organization resets the group to that organization's first.
    selectOrganization: (organizationId: string) =>
      setScopeValue(
        options.find((option) => option.organizationId === organizationId)
          ?.value,
      ),
    errors,
    failure,
    confirming,
    confirmationRequests,
    dismissConfirmation: () => setConfirming(false),
    confirmNewOperation,
    uncertain,
    afterFailure,
    pending: create.isPending,
    created,
    submit,
    restart,
    register,
  };
}
