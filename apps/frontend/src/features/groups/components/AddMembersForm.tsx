import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { CollapsibleSection } from "../../../components/CollapsibleSection";
import { describeError } from "../../auth/api/apiError";
import { MAX_BULK_MEMBERS } from "../../../lib/limits";
import { fromApiRut } from "../../../lib/rut";
import { MemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import {
  NO_PERMISSIONS,
  permissionRatio,
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
  // The check in flight, cancelled when the form goes away: a check that
  // resolves after unmount must not send anything.
  const check = useRef<AbortController | null>(null);
  useEffect(() => () => check.current?.abort(), []);
  // The submit button is disabled during the check, so after pruning the focus
  // would fall to the page: land on the message that explains what happened.
  useEffect(() => {
    if (gone.length > 0) goneAlert.current?.focus();
  }, [gone]);
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
      clearGone();
      setSelected((current) => {
        const next = new Map(current);
        if (!next.delete(user.id))
          next.set(user.id, { user, permissions: NO_PERMISSIONS });
        return next;
      });
    },
    [clearGone],
  );
  const toggleAllOnPage = () => {
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
    (id: string, permissions: InvoicePermissions) =>
      setSelected((current) => {
        const existing = current.get(id);
        return existing
          ? new Map(current).set(id, { ...existing, permissions })
          : current;
      }),
    [],
  );
  const applyToAll = () =>
    setSelected(
      (current) =>
        new Map(
          [...current].map(([id, entry]) => [
            id,
            { ...entry, permissions: { ...sharedDraft } },
          ]),
        ),
    );
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
      clearGone();
      setSelected((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    },
    [clearGone],
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

  return (
    <form onSubmit={submit} noValidate aria-labelledby="add-members-title">
      <h2 id="add-members-title">Personas de la organización</h2>
      {/* One fieldset disables the whole picker while the request runs, so no
          row has to re-render for it. */}
      <fieldset className="plain-fieldset" disabled={pending}>
        {candidates === undefined ? null : emptyMessage ? (
          <p role="status">{emptyMessage}</p>
        ) : (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={allPageSelected}
                disabled={pageCandidates.length === 0}
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
                  onToggle={toggle}
                />
              ))}
            </ul>
          </>
        )}
        {pager}
        <p role="status" aria-live="polite" className="muted">
          {chosen.length === 0
            ? "Aún no seleccionas a nadie."
            : chosen.length === 1
              ? "1 persona seleccionada."
              : `${chosen.length} personas seleccionadas.`}
        </p>
      </fieldset>
      {chosen.length > 0 ? (
        <>
          <section aria-labelledby="apply-all-title">
            <h3 id="apply-all-title">Aplicar los mismos permisos a todos</h3>
            <MemberPermissionsEditor
              memberName="todas las personas seleccionadas"
              level="group"
              value={sharedDraft}
              onChange={setSharedDraft}
              disabled={pending}
            />
            <div className="action-row">
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={applyToAll}
              >
                Aplicar a todos los seleccionados
              </button>
            </div>
          </section>
          <fieldset className="plain-fieldset" disabled={pending}>
            {chosen.map(({ user, permissions }) => (
              <SelectedCard
                key={user.id}
                user={user}
                permissions={permissions}
                open={open.has(user.id)}
                onToggleOpen={toggleOpen}
                onRemove={removeById}
                onPermissions={setPermissions}
              />
            ))}
          </fieldset>
        </>
      ) : null}
      {tooMany ? (
        <p role="alert">
          Puedes agregar hasta {MAX_BULK_MEMBERS} personas por operación.
        </p>
      ) : null}
      {add.isError ? (
        <p role="alert">
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
      <button
        type="submit"
        disabled={pending || chosen.length === 0 || tooMany}
      >
        {pending
          ? checking
            ? "Comprobando..."
            : "Agregando..."
          : chosen.length === 0
            ? "Agregar personas al grupo"
            : chosen.length === 1
              ? "Agregar 1 persona al grupo"
              : `Agregar ${chosen.length} personas al grupo`}
      </button>
    </form>
  );
}

/** One organization member in the pick list (memoized: one page of rows). */
const CandidateRow = memo(function CandidateRow({
  user,
  checked,
  onToggle,
}: {
  user: OrganizationUser;
  checked: boolean;
  onToggle: (user: OrganizationUser) => void;
}) {
  return (
    <li>
      <label className="check-row">
        <input
          type="checkbox"
          checked={checked}
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
 * While a request is in flight the form's fieldset disables the controls, so
 * no card has to re-render for that either.
 */
const SelectedCard = memo(function SelectedCard({
  user,
  permissions,
  open,
  onToggleOpen,
  onRemove,
  onPermissions,
}: {
  user: OrganizationUser;
  permissions: InvoicePermissions;
  open: boolean;
  onToggleOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onPermissions: (id: string, permissions: InvoicePermissions) => void;
}) {
  return (
    <CollapsibleSection
      title={user.name}
      summary={`${permissionRatio(permissions)} permisos`}
      open={open}
      onToggle={() => onToggleOpen(user.id)}
      renderFolded={false}
      actions={
        <button
          type="button"
          className="subtle-danger-button"
          aria-label={`Quitar a ${user.name} de la selección`}
          onClick={() => onRemove(user.id)}
        >
          Quitar
        </button>
      }
    >
      <p className="muted" aria-live="polite">
        {permissionRatio(permissions)} permisos
      </p>
      <MemberPermissionsEditor
        memberName={user.name}
        level="group"
        value={permissions}
        onChange={(next) => onPermissions(user.id, next)}
      />
    </CollapsibleSection>
  );
});
