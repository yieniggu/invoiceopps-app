import {
  memo,
  useCallback,
  useId,
  useMemo,
  useState,
  type FormEvent,
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
import { useAddGroupMembers } from "../hooks/useGroups";

/** Said once, after the reason, whenever the batch fails. */
const NOTHING_ADDED = "No se agregó a nadie.";

/** Lowercase without accents, so "peña" finds "Pena". */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/** Name or RUT (any spelling: dots and dash are ignored). */
function matchesSearch(user: OrganizationUser, query: string) {
  const text = plain(query);
  if (text === "") return true;
  if (plain(user.name).includes(text)) return true;
  const rut = text.replace(/[.\-\s]/g, "");
  return rut !== "" && user.rut.toLowerCase().includes(rut);
}

/**
 * Picks several organization members for a group, each with their own
 * permissions, and adds them in one atomic request: either everybody is added
 * or nobody (so a failure is simply retried). The selection and the drafts are
 * the person's choices; the candidates come straight from the queries.
 */
export function AddMembersForm({
  organizationId,
  groupId,
  candidates,
  onAdded,
}: {
  organizationId: string;
  groupId: string;
  /** Organization members that are not in the group yet. */
  candidates: readonly OrganizationUser[];
  onAdded: (count: number) => void;
}) {
  const searchId = useId();
  const add = useAddGroupMembers(organizationId, groupId);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<
    ReadonlyMap<string, InvoicePermissions>
  >(new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [sharedDraft, setSharedDraft] =
    useState<InvoicePermissions>(NO_PERMISSIONS);
  // The people sent in the last attempt: when it fails because the list
  // changed, those who are no longer candidates after the refresh are named.
  const [attempted, setAttempted] = useState<
    ReadonlyArray<{ id: string; name: string }>
  >([]);

  const visible = useMemo(
    () => candidates.filter((user) => matchesSearch(user, search)),
    [candidates, search],
  );
  const candidateIds = new Set(candidates.map(({ id }) => id));
  // A person who stopped being a candidate (joined the group, or left the
  // organization) leaves the selection for good: if they come back they start
  // unselected, never with flags chosen for a previous state. Setting state
  // while rendering is safe here: the guard is false on the next pass.
  if ([...selected.keys()].some((id) => !candidateIds.has(id)))
    setSelected(
      (current) => new Map([...current].filter(([id]) => candidateIds.has(id))),
    );
  const chosen = candidates.filter(({ id }) => selected.has(id));
  const allVisibleSelected =
    visible.length > 0 && visible.every(({ id }) => selected.has(id));
  const tooMany = chosen.length > MAX_BULK_MEMBERS;
  const pending = add.isPending;
  const gone = add.isError
    ? attempted.filter(({ id }) => !candidateIds.has(id))
    : [];

  // The callbacks handed to the (up to 400) memoized rows never change, so
  // ticking one person re-renders that row and its card, not the whole list.
  const toggle = useCallback(
    (id: string) =>
      setSelected((current) => {
        const next = new Map(current);
        if (!next.delete(id)) next.set(id, NO_PERMISSIONS);
        return next;
      }),
    [],
  );
  const toggleAllVisible = () =>
    setSelected((current) => {
      const next = new Map(current);
      for (const { id } of visible) {
        if (allVisibleSelected) next.delete(id);
        else if (!next.has(id)) next.set(id, NO_PERMISSIONS);
      }
      return next;
    });
  const setPermissions = useCallback(
    (id: string, permissions: InvoicePermissions) =>
      setSelected((current) =>
        current.has(id) ? new Map(current).set(id, permissions) : current,
      ),
    [],
  );
  const applyToAll = () =>
    setSelected(
      (current) =>
        new Map([...current.keys()].map((id) => [id, { ...sharedDraft }])),
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || chosen.length === 0 || tooMany) return;
    // Captured now: edits during the request cannot change what is sent.
    const members = chosen.map(({ id }) => ({
      userId: id,
      permissions: { ...(selected.get(id) ?? NO_PERMISSIONS) },
    }));
    setAttempted(chosen.map(({ id, name }) => ({ id, name })));
    add.mutate(members, { onSuccess: () => onAdded(members.length) });
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby="add-members-title">
      <h2 id="add-members-title">Personas de la organización</h2>
      {candidates.length === 0 ? (
        <p>
          No hay más personas de la organización para agregar: todas ya están en
          el grupo.
        </p>
      ) : (
        // One fieldset disables the whole picker while the request runs, so no
        // row has to re-render for it.
        <fieldset className="plain-fieldset" disabled={pending}>
          <label htmlFor={searchId}>Buscar por nombre o RUT</label>
          <input
            id={searchId}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="check-row">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              disabled={visible.length === 0}
              onChange={toggleAllVisible}
            />
            Seleccionar todos
          </label>
          {visible.length === 0 ? (
            <p role="status">Ninguna persona coincide con la búsqueda.</p>
          ) : (
            <ul className="checkbox-list">
              {visible.map((user) => (
                <CandidateRow
                  key={user.id}
                  user={user}
                  checked={selected.has(user.id)}
                  onToggle={toggle}
                />
              ))}
            </ul>
          )}
          <p role="status" aria-live="polite" className="muted">
            {chosen.length === 0
              ? "Aún no seleccionas a nadie."
              : chosen.length === 1
                ? "1 persona seleccionada."
                : `${chosen.length} personas seleccionadas.`}
          </p>
        </fieldset>
      )}
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
            {chosen.map((user) => (
              <SelectedCard
                key={user.id}
                user={user}
                permissions={selected.get(user.id) ?? NO_PERMISSIONS}
                open={open.has(user.id)}
                onToggleOpen={toggleOpen}
                onRemove={toggle}
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
        <p role="alert">
          {gone.map(({ name }) => name).join(", ")}{" "}
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
          ? "Agregando..."
          : chosen.length === 0
            ? "Agregar personas al grupo"
            : chosen.length === 1
              ? "Agregar 1 persona al grupo"
              : `Agregar ${chosen.length} personas al grupo`}
      </button>
    </form>
  );
}

/** One organization member in the pick list (memoized: up to 200 rows). */
const CandidateRow = memo(function CandidateRow({
  user,
  checked,
  onToggle,
}: {
  user: OrganizationUser;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <li>
      <label className="check-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(user.id)}
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
