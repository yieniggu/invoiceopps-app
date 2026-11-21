import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { ChevronDown, ChevronRight } from "lucide-react";

import { PendingButton } from "../../../components/PendingButton";
import { CollapsibleSection } from "../../../components/CollapsibleSection";
import { describeError } from "../../auth/api/apiError";
import { MAX_BULK_MEMBERS } from "../../../lib/limits";
import { fromApiRut } from "../../../lib/rut";
import { PermissionRatio } from "../../permissions/components/DeployModelsIndicator";
import { MemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import {
  NO_PERMISSIONS,
  type InvoicePermissions,
} from "../../permissions/types";
import type { OrganizationUser } from "../../users/types";
import { isApiError } from "../../auth/api/apiError";
import { useAddGroupMembers, useUnavailableMembers } from "../hooks/useGroups";

/** Said once, after the reason, whenever the batch fails. */
const NOTHING_ADDED = "No se agregó a nadie.";

/** A person picked on any page, with the permissions chosen for them. */
interface Chosen {
  user: OrganizationUser;
  permissions: InvoicePermissions;
}

/**
 * Picks several organization members for a group, each with their own
 * permissions, and adds them in one atomic request: either everybody is added
 * or nobody (so a failure is simply retried).
 *
 * The list shows one page of candidates at a time (searching and paging are
 * the screen's job). The selection belongs to the whole flow, not to a page:
 * this is an add flow, so a person picked on page 1 stays picked while the
 * page or the search changes, and the counter ("N personas seleccionadas")
 * and the cards below the list always show everybody who will be added. The
 * cap of 200 people per operation applies to that whole selection.
 *
 * Layout: the list comes first and its pager is the last block of the list
 * area. Below it the picked people sit behind a one-line disclosure (closed by
 * default) that, with the submit button, forms the step's action bar: picking
 * somebody never moves the row that was clicked, and the pager stays directly
 * above the action bar however many people are picked.
 *
 * While a request runs nothing is `disabled` (a disabled control that has
 * focus sends it to the page): controls get `aria-disabled`, their handlers
 * ignore the action, and a failure moves focus to its alert.
 */
export function AddMembersForm({
  organizationId,
  groupId,
  candidates,
  pageMemberIds,
  emptyMessage,
  pager,
  onAdded,
}: {
  organizationId: string;
  groupId: string;
  /** People of the page on screen who are not in the group yet; undefined
   * while that page is loading. */
  candidates: readonly OrganizationUser[] | undefined;
  /** People of the page on screen who are in the group already. */
  pageMemberIds: ReadonlySet<string> | undefined;
  /** Said instead of the list when the page has nobody to offer. */
  emptyMessage: string | undefined;
  /** Pagination controls, placed right below the list. */
  pager: ReactNode;
  onAdded: (count: number) => void;
}) {
  const add = useAddGroupMembers(organizationId, groupId);
  const findUnavailable = useUnavailableMembers(organizationId, groupId);
  const [selected, setSelected] = useState<ReadonlyMap<string, Chosen>>(
    new Map(),
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showChosen, setShowChosen] = useState(false);
  const chosenBodyId = useId();
  const [sharedDraft, setSharedDraft] =
    useState<InvoicePermissions>(NO_PERMISSIONS);
  // True while the whole selection is checked against the server just before
  // sending it.
  const [checking, setChecking] = useState(false);
  // The people who can no longer be added (found by the pre-check, or after a
  // 404/409): named, and already out of the selection. Cleared as soon as the
  // person changes the selection.
  const [gone, setGone] = useState<ReadonlyArray<string>>([]);
  const goneAlert = useRef<HTMLParagraphElement>(null);
  const failureAlert = useRef<HTMLParagraphElement>(null);
  // The check in flight, cancelled when the form goes away: a check that
  // resolves after unmount must not send anything.
  const check = useRef<AbortController | null>(null);
  useEffect(() => () => check.current?.abort(), []);
  // After pruning, land on the message that explains what happened.
  useEffect(() => {
    if (gone.length > 0) goneAlert.current?.focus();
  }, [gone]);
  // A failed request: focus was on the (inert) submit button, so it moves to
  // the message that says nobody was added.
  const failed = add.isError;
  useEffect(() => {
    if (failed) failureAlert.current?.focus();
  }, [failed]);
  // Removing a card must not drop focus to the page: who was removed (and
  // who sat next to them) waits here until the removal has rendered, then
  // focus goes to the neighbour's «Quitar» or, with nobody left, to the
  // person's checkbox in the list or the list's title.
  const removal = useRef<{ id: string; neighbour: string | null } | null>(null);
  const orderedIds = useRef<readonly string[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const listTitle = useRef<HTMLHeadingElement>(null);
  const clearGone = useCallback(
    () => setGone((current) => (current.length > 0 ? [] : current)),
    [],
  );

  // A person of the page on screen who is in the group after all (joined
  // meanwhile) leaves the selection for good: if they come back they start
  // unselected, never with flags chosen for a previous state. People of other
  // pages are only checked when their page is shown. Setting state while
  // rendering is safe here: the guard is false on the next pass.
  if (pageMemberIds && [...selected.keys()].some((id) => pageMemberIds.has(id)))
    setSelected(
      (current) =>
        new Map([...current].filter(([id]) => !pageMemberIds.has(id))),
    );
  const chosen = useMemo(
    () =>
      [...selected.values()].sort(
        (a, b) =>
          a.user.name.localeCompare(b.user.name) ||
          a.user.id.localeCompare(b.user.id),
      ),
    [selected],
  );
  useEffect(() => {
    orderedIds.current = chosen.map(({ user }) => user.id);
    const done = removal.current;
    if (done === null || selected.has(done.id)) return;
    removal.current = null;
    const find = (selector: string, value: string) =>
      form.current?.querySelector<HTMLElement>(
        `[${selector}="${CSS.escape(value)}"]`,
      );
    (done.neighbour ? find("data-remove-id", done.neighbour) : null)?.focus();
    if (document.activeElement?.hasAttribute("data-remove-id")) return;
    (find("data-person-id", done.id) ?? listTitle.current)?.focus();
  }, [chosen, selected]);
  const pageCandidates = candidates ?? [];
  const allPageSelected =
    pageCandidates.length > 0 &&
    pageCandidates.every(({ id }) => selected.has(id));
  const tooMany = chosen.length > MAX_BULK_MEMBERS;
  const pending = add.isPending || checking;

  // The callbacks handed to the memoized rows never change, so ticking one
  // person re-renders that row and its card, not the whole list.
  const toggle = useCallback(
    (user: OrganizationUser) => {
      if (pending) return;
      clearGone();
      setSelected((current) => {
        const next = new Map(current);
        if (!next.delete(user.id))
          next.set(user.id, { user, permissions: NO_PERMISSIONS });
        return next;
      });
    },
    [clearGone, pending],
  );
  const toggleAllOnPage = () => {
    if (pending) return;
    clearGone();
    setSelected((current) => {
      const next = new Map(current);
      for (const user of pageCandidates) {
        if (allPageSelected) next.delete(user.id);
        else if (!next.has(user.id))
          next.set(user.id, { user, permissions: NO_PERMISSIONS });
      }
      return next;
    });
  };
  const setPermissions = useCallback(
    (id: string, permissions: InvoicePermissions) => {
      if (pending) return;
      setSelected((current) => {
        const existing = current.get(id);
        return existing
          ? new Map(current).set(id, { ...existing, permissions })
          : current;
      });
    },
    [pending],
  );
  const applyToAll = () => {
    if (pending) return;
    setSelected(
      (current) =>
        new Map(
          [...current].map(([id, entry]) => [
            id,
            { ...entry, permissions: { ...sharedDraft } },
          ]),
        ),
    );
  };
  const toggleOpen = useCallback(
    (id: string) =>
      setOpen((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const removeById = useCallback(
    (id: string) => {
      if (pending) return;
      clearGone();
      // Who takes focus is decided from the order on screen at this moment.
      const ids = orderedIds.current;
      const index = ids.indexOf(id);
      removal.current = {
        id,
        neighbour: ids[index + 1] ?? ids[index - 1] ?? null,
      };
      setSelected((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    },
    [clearGone, pending],
  );

  const prune = (
    attempted: readonly OrganizationUser[],
    unavailable: Set<string>,
  ) => {
    setGone(
      attempted.filter(({ id }) => unavailable.has(id)).map(({ name }) => name),
    );
    setSelected(
      (current) => new Map([...current].filter(([id]) => !unavailable.has(id))),
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || chosen.length === 0 || tooMany) return;
    // Captured now: edits during the request cannot change what is sent.
    const members = chosen.map(({ user, permissions }) => ({
      userId: user.id,
      permissions: { ...permissions },
    }));
    const attempted = chosen.map(({ user }) => user);
    check.current?.abort();
    const controller = new AbortController();
    check.current = controller;
    const { signal } = controller;
    const send = () =>
      add.mutate(members, {
        onSuccess: () => onAdded(members.length),
        onError: (error) => {
          if (
            !isApiError(error) ||
            (error.status !== 404 && error.status !== 409)
          )
            return;
          // Anyone of the selection (on any page) may be the one who changed.
          findUnavailable(
            attempted.map(({ id }) => id),
            signal,
          ).then(
            (unavailable) => {
              if (unavailable.size > 0) prune(attempted, unavailable);
            },
            // The generic message above already says nobody was added.
            () => undefined,
          );
        },
      });
    setGone([]);
    // Only the page on screen is known to be current, so the whole selection
    // is checked by id first. Whoever joined the group (or left the
    // organization) meanwhile is dropped and named, and nothing is sent: the
    // person sees the final list and confirms it with another click. If the
    // check itself fails the request goes ahead and the server decides (a
    // 404/409 is handled below).
    setChecking(true);
    findUnavailable(
      attempted.map(({ id }) => id),
      signal,
    ).then(
      (unavailable) => {
        if (signal.aborted) return;
        setChecking(false);
        if (unavailable.size > 0) {
          add.reset();
          prune(attempted, unavailable);
        } else send();
      },
      () => {
        if (signal.aborted) return;
        setChecking(false);
        send();
      },
    );
  };

  const count =
    chosen.length === 1
      ? "1 persona seleccionada"
      : `${chosen.length} personas seleccionadas`;
  const ChosenChevron = showChosen ? ChevronDown : ChevronRight;

  return (
    <form
      ref={form}
      onSubmit={submit}
      noValidate
      aria-labelledby="add-members-title"
      className="fill-column"
    >
      <h2 id="add-members-title" ref={listTitle} tabIndex={-1}>
        Personas de la organización
      </h2>
      <fieldset className="plain-fieldset fill-column">
        {/* The list's own name. It differs from the form's (the title above),
            so a screen reader does not announce the same words twice. */}
        <legend className="visually-hidden">
          Personas disponibles para agregar
        </legend>
        {candidates === undefined ? null : emptyMessage ? (
          <p role="status">{emptyMessage}</p>
        ) : (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={allPageSelected}
                disabled={pageCandidates.length === 0}
                aria-disabled={pending || undefined}
                onChange={toggleAllOnPage}
              />
              Seleccionar todos en esta página
            </label>
            <ul className="checkbox-list">
              {pageCandidates.map((user) => (
                <CandidateRow
                  key={user.id}
                  user={user}
                  checked={selected.has(user.id)}
                  locked={pending}
                  onToggle={toggle}
                />
              ))}
            </ul>
          </>
        )}
        {/* Heard, not seen: the visible count is the disclosure's summary. */}
        <p role="status" aria-live="polite" className="visually-hidden">
          {chosen.length === 0 ? "Aún no seleccionas a nadie." : `${count}.`}
        </p>
        {pager}
      </fieldset>
      {/* The step's action bar: a one-line summary that unfolds the picked
          people, then the submit. It sits under the pager, so the list never
          moves when somebody is picked. */}
      {chosen.length > 0 ? (
        <div className="selected-people" data-action-bar="">
          <h2 className="selected-people-title">
            <button
              type="button"
              className="collapse-toggle"
              aria-expanded={showChosen}
              aria-controls={chosenBodyId}
              onClick={() => setShowChosen((current) => !current)}
            >
              <ChosenChevron aria-hidden="true" focusable="false" size={18} />
              <span>{`${count} · Ajustar permisos`}</span>
            </button>
          </h2>
          <div id={chosenBodyId} hidden={!showChosen}>
            {showChosen ? (
              <>
                <section aria-labelledby="apply-all-title">
                  <h3 id="apply-all-title">
                    Aplicar los mismos permisos a todos
                  </h3>
                  <MemberPermissionsEditor
                    memberName="todas las personas seleccionadas"
                    level="group"
                    value={sharedDraft}
                    onChange={(next) => {
                      if (!pending) setSharedDraft(next);
                    }}
                    disabled={pending}
                  />
                  <div className="action-row">
                    <button
                      type="button"
                      className="secondary-button"
                      aria-disabled={pending || undefined}
                      onClick={applyToAll}
                    >
                      Aplicar a todos los seleccionados
                    </button>
                  </div>
                </section>
                <div className="plain-fieldset">
                  {chosen.map(({ user, permissions }) => (
                    <SelectedCard
                      key={user.id}
                      user={user}
                      permissions={permissions}
                      open={open.has(user.id)}
                      locked={pending}
                      onToggleOpen={toggleOpen}
                      onRemove={removeById}
                      onPermissions={setPermissions}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {tooMany ? (
        <p role="alert">
          Puedes agregar hasta {MAX_BULK_MEMBERS} personas por operación.
        </p>
      ) : null}
      {add.isError ? (
        <p role="alert" tabIndex={-1} ref={failureAlert}>
          {describeError(
            add.error,
            "No fue posible agregar a las personas. Intenta nuevamente.",
          )}{" "}
          {NOTHING_ADDED}
        </p>
      ) : null}
      {gone.length > 0 ? (
        <p role="alert" tabIndex={-1} ref={goneAlert}>
          {gone.join(", ")}{" "}
          {gone.length === 1
            ? "ya no se puede agregar al grupo (ya está en él o dejó la organización) y se quitó de la selección."
            : "ya no se pueden agregar al grupo (ya están en él o dejaron la organización) y se quitaron de la selección."}
        </p>
      ) : null}
      <PendingButton
        type="submit"
        disabled={chosen.length === 0 || tooMany}
        aria-disabled={pending || undefined}
        pending={pending}
        announce={{
          pending: checking ? "Comprobando personas" : "Agregando personas",
        }}
      >
        {chosen.length === 0
          ? "Agregar personas al grupo"
          : chosen.length === 1
            ? "Agregar 1 persona al grupo"
            : `Agregar ${chosen.length} personas al grupo`}
      </PendingButton>
    </form>
  );
}

/** One organization member in the pick list (memoized: one page of rows). */
const CandidateRow = memo(function CandidateRow({
  user,
  checked,
  locked,
  onToggle,
}: {
  user: OrganizationUser;
  checked: boolean;
  locked: boolean;
  onToggle: (user: OrganizationUser) => void;
}) {
  return (
    <li>
      <label className="check-row">
        <input
          type="checkbox"
          data-person-id={user.id}
          checked={checked}
          aria-disabled={locked || undefined}
          onChange={() => onToggle(user)}
        />
        <span>
          {user.name} <span className="muted">({fromApiRut(user.rut)})</span>
        </span>
      </label>
    </li>
  );
});

/**
 * The card of one selected person: a one-line summary while folded and the
 * permission editor once opened. Memoized, with stable callbacks from the
 * form, so changing one person does not re-render the other 199 cards; the
 * editor is only built while the card is open (its value lives in the form).
 * While a request is in flight `locked` turns the controls `aria-disabled`
 * (the handlers ignore them): two cheap re-renders per submit.
 */
const SelectedCard = memo(function SelectedCard({
  user,
  permissions,
  open,
  locked,
  onToggleOpen,
  onRemove,
  onPermissions,
}: {
  user: OrganizationUser;
  permissions: InvoicePermissions;
  open: boolean;
  locked: boolean;
  onToggleOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onPermissions: (id: string, permissions: InvoicePermissions) => void;
}) {
  return (
    <CollapsibleSection
      title={user.name}
      summary={<PermissionRatio permissions={permissions} />}
      open={open}
      onToggle={() => onToggleOpen(user.id)}
      renderFolded={false}
      actions={
        <button
          type="button"
          className="subtle-danger-button"
          data-remove-id={user.id}
          aria-label={`Quitar a ${user.name} de la selección`}
          aria-disabled={locked || undefined}
          onClick={() => onRemove(user.id)}
        >
          Quitar
        </button>
      }
    >
      <p className="muted" aria-live="polite">
        <PermissionRatio permissions={permissions} />
      </p>
      <MemberPermissionsEditor
        memberName={user.name}
        level="group"
        value={permissions}
        disabled={locked}
        onChange={(next) => onPermissions(user.id, next)}
      />
    </CollapsibleSection>
  );
});
