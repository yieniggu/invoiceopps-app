import { Plus } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { FieldMessage } from "../../../components/FieldMessage";
import { LinkButton } from "../../../components/LinkButton";
import { PasswordInput } from "../../../components/PasswordInput";
import { RutField } from "../../../components/RutField";
import { paths } from "../../navigation/paths";
import { MAX_TOTAL_GROUP_GRANTS } from "../../../lib/limits";
import {
  countGroupGrants,
  emptyOrganization,
  emptyUser,
  MAX_ORGANIZATIONS,
  MAX_TEMPORARY_PASSWORD_LENGTH,
  validateData,
  staleGroups,
  staleOrganizations,
  validateGroups,
  validateOrganizations,
  type OrganizationDraft,
  type OrganizationOption,
  type PasswordMode,
  type UserDraft,
} from "../wizard/draft";
import { classifyFailure } from "../wizard/failure";
import { useDraftGroupOptions } from "../wizard/useDraftGroupOptions";
import { GroupsStep } from "../wizard/GroupsStep";
import { OrganizationDraftCard } from "../wizard/OrganizationDraftCard";
import { useKeySet } from "../wizard/useOpenSet";
import { WizardSummary } from "../wizard/WizardSummary";

type Step = 1 | 2 | 3 | 4;
const LAST_STEP = 4;
const STEP_LABELS = ["Datos", "Organizaciones", "Grupos", "Resumen"] as const;
const STEP_TITLES = [
  "Datos del usuario",
  "Organizaciones",
  "Grupos",
  "Resumen",
] as const;

/** How the wizard asks for the creation; the callers own the mutation. */
export interface WizardSubmitter {
  isPending: boolean;
  error: unknown;
  submit: (
    draft: UserDraft,
    callbacks: {
      onSuccess: (createdName: string) => void;
      onError: (error: unknown) => void;
    },
  ) => void;
  reset: () => void;
}

/**
 * Four-step create-user wizard: data, organizations (role and permissions),
 * groups and summary. With `fixedOrganization` it runs in single-organization
 * mode: that organization is preselected and cannot change. All values are
 * local drafts; nothing is sent until the summary step is confirmed.
 */
export function CreateUserWizard({
  organizations,
  organizationsTotal,
  fixedOrganization,
  initialOrganizationId,
  initialOrganization,
  submitter,
  successFocusRef,
  title,
  headingLevel = 2,
  doneAction,
}: {
  /** Selectable organizations (platform mode): the first page of the list. */
  organizations: OrganizationOption[];
  /**
   * How many organizations exist in all. When it exceeds `organizations`, the
   * picker searches the server for the rest.
   */
  organizationsTotal?: number;
  fixedOrganization?: OrganizationOption;
  /** Platform mode: an organization to start with (already validated). */
  initialOrganizationId?: string;
  /** The starting organization when it is not in the first page. */
  initialOrganization?: OrganizationOption;
  submitter: WizardSubmitter;
  /** Receives focus when the temporary-password dialog closes. */
  successFocusRef: RefObject<HTMLButtonElement | null>;
  /** Visible form title when the screen does not provide a page title. */
  title?: string;
  headingLevel?: 2 | 3;
  doneAction?: ReactNode;
}) {
  const startOrganization = fixedOrganization?.id ?? initialOrganizationId;
  const listed = fixedOrganization ? [fixedOrganization] : organizations;
  // Only a page of the list is preloaded when there are many organizations.
  const total = fixedOrganization
    ? 1
    : Math.max(organizationsTotal ?? listed.length, listed.length);
  const complete = total <= listed.length;
  const titleId = useId();
  const nameMessageId = useId();
  const passwordMessageId = useId();
  const repeatMessageId = useId();
  const addReasonId = useId();
  const [draft, setDraft] = useState<UserDraft>(() =>
    emptyUser(startOrganization, initialOrganization),
  );
  const [step, setStep] = useState<Step>(1);
  const [attempted, setAttempted] = useState(false);
  const [focusInvalid, setFocusInvalid] = useState(0);
  const [created, setCreated] = useState<{
    name: string;
    mode: PasswordMode;
  }>();
  // Folding state lives here so it survives moving between steps. Step 2 cards
  // and step 3 groups are open when listed; step 3 organization sections are
  // open unless listed.
  const openOrganizations = useKeySet(
    draft.organizations.map(({ key }) => key),
  );
  const collapsedSections = useKeySet();
  const openGroups = useKeySet();
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const stepChanged = useRef(false);

  // Moving between steps lands on the new step heading (DOM synchronisation).
  useEffect(() => {
    if (stepChanged.current) heading.current?.focus();
  }, [step]);
  // After a failed validation, focus the first invalid control.
  useEffect(() => {
    if (focusInvalid > 0)
      body.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [focusInvalid]);

  // Every organization the wizard can name: the preloaded page plus those the
  // person found by searching (the draft remembers them).
  const options = [...listed];
  for (const { picked } of draft.organizations)
    if (picked && !options.some(({ id }) => id === picked.id))
      options.push(picked);

  const failure = submitter.error
    ? classifyFailure(submitter.error)
    : undefined;
  const pending = submitter.isPending;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const memberName = draft.name.trim() || "la persona nueva";

  const update = (next: UserDraft) => {
    if (submitter.error) submitter.reset();
    setDraft(next);
  };
  const goTo = (next: Step) => {
    stepChanged.current = true;
    setAttempted(false);
    setStep(next);
  };
  const reject = () => {
    setAttempted(true);
    setFocusInvalid((count) => count + 1);
  };

  const dataErrors = validateData(draft);
  // What was chosen must still exist among the loaded options: a refresh can
  // remove an organization or a group while the draft keeps its id.
  const groupOptions = useDraftGroupOptions(draft, step >= 3);
  const organizationErrors = validateOrganizations(draft, listed, complete);
  const groupErrors = validateGroups(draft, groupOptions);
  const staleOrganizationMessages = staleOrganizations(draft, listed, complete);
  const staleGroupMessages = staleGroups(draft, groupOptions);
  const dataValid =
    !dataErrors.name &&
    !dataErrors.rut &&
    !dataErrors.password &&
    !dataErrors.repeat;
  const organizationsValid = Object.keys(organizationErrors).length === 0;
  const groupsValid = Object.keys(groupErrors).length === 0;

  // An entry with errors must be visible when the person tries to advance.
  const rejectOrganizations = () => {
    openOrganizations.add(Object.keys(organizationErrors));
    reject();
  };
  const rejectGroups = () => {
    const withErrors = draft.organizations
      .filter(({ groups }) => groups.some(({ key }) => groupErrors[key]))
      .map(({ key }) => key);
    collapsedSections.remove(withErrors);
    openGroups.add(Object.keys(groupErrors));
    reject();
  };

  const create = () => {
    if (pending) return;
    if (!dataValid) {
      goTo(1);
      reject();
      return;
    }
    if (!organizationsValid) {
      goTo(2);
      rejectOrganizations();
      return;
    }
    if (!groupsValid) {
      goTo(3);
      rejectGroups();
      return;
    }
    const mode = draft.passwordMode;
    submitter.submit(draft, {
      onSuccess: (name) => {
        setCreated({ name, mode });
        setDraft(emptyUser(startOrganization, initialOrganization));
        stepChanged.current = false;
        setAttempted(false);
        setStep(1);
      },
      onError: (error) => goTo(classifyFailure(error).step),
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    if (step === 1) {
      if (dataValid) goTo(2);
      else reject();
    } else if (step === 2) {
      if (organizationsValid) goTo(3);
      else rejectOrganizations();
    } else if (step === 3) {
      if (groupsValid) goTo(4);
      else rejectGroups();
    } else {
      create();
    }
  };

  if (created !== undefined) {
    return (
      <section className="screen-stack" aria-labelledby={titleId}>
        <Heading id={titleId}>Usuario creado</Heading>
        <p role="status">
          {created.mode === "defined"
            ? `Se creó a ${created.name}. La persona deberá cambiarla al iniciar sesión.`
            : `Se creó a ${created.name}. La contraseña temporal se muestra una sola vez en el cuadro de diálogo; entrégala a la persona.`}
        </p>
        <div className="action-row">
          <button
            ref={successFocusRef}
            type="button"
            onClick={() => {
              setCreated(undefined);
              submitter.reset();
            }}
          >
            Crear otro usuario
          </button>
          {doneAction}
        </div>
      </section>
    );
  }

  const changeOrganization = (key: string, next: OrganizationDraft) =>
    update({
      ...draft,
      organizations: draft.organizations.map((organization) =>
        organization.key === key ? next : organization,
      ),
    });
  const chosen = new Set(
    draft.organizations.map(({ organizationId }) => organizationId),
  );
  // With many organizations "none left" cannot be known from the page alone.
  const exhausted = complete && listed.every(({ id }) => chosen.has(id));
  const addOrganization = () => {
    const added = emptyOrganization();
    update({ ...draft, organizations: [...draft.organizations, added] });
    // The new entry is the one being filled in: fold the others.
    openOrganizations.replace([added.key]);
  };
  const stepTitle = `Paso ${step} de ${LAST_STEP}: ${
    step === 2 && fixedOrganization ? "Rol y permisos" : STEP_TITLES[step - 1]
  }`;
  const nameMessage =
    (attempted && step === 1 ? dataErrors.name : "") || (failure?.name ?? "");
  const passwordMessage =
    (attempted && step === 1 ? dataErrors.password : "") ||
    (failure?.password ?? "");
  const repeatMessage = attempted && step === 1 ? dataErrors.repeat : "";
  const chooseMode = (passwordMode: PasswordMode) =>
    update({
      ...draft,
      passwordMode,
      temporaryPassword: "",
      temporaryPasswordRepeat: "",
    });

  const addDisabledReason = exhausted
    ? "Ya agregaste todas las organizaciones disponibles."
    : draft.organizations.length >= MAX_ORGANIZATIONS
      ? `Alcanzaste el máximo de ${MAX_ORGANIZATIONS} organizaciones.`
      : "";

  return (
    <form
      className="surface"
      onSubmit={submit}
      noValidate
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : "Crear usuario"}
    >
      {title ? <h2 id={titleId}>{title}</h2> : null}
      <ol className="wizard-steps" aria-label="Pasos">
        {STEP_LABELS.map((label, index) => (
          <li
            key={label}
            aria-current={step === index + 1 ? "step" : undefined}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      <Heading ref={heading} tabIndex={-1}>
        {stepTitle}
      </Heading>
      <div ref={body} className="screen-stack">
        {step === 1 ? (
          <>
            <label>
              Nombre completo
              <input
                value={draft.name}
                onChange={(event) =>
                  update({ ...draft, name: event.target.value })
                }
                disabled={pending}
                aria-invalid={nameMessage !== ""}
                aria-describedby={nameMessageId}
                required
              />
            </label>
            <FieldMessage id={nameMessageId} text={nameMessage} />
            <RutField
              label="RUT del usuario"
              missingMessage="Ingresa el RUT"
              value={draft.rut}
              onChange={(rut) => update({ ...draft, rut })}
              disabled={pending}
              submitted={attempted}
              serverMessage={failure?.rut}
              required
            />
            <fieldset className="choice-group" disabled={pending}>
              <legend>Contraseña temporal</legend>
              <label>
                <input
                  type="radio"
                  name="passwordMode"
                  checked={draft.passwordMode === "generated"}
                  onChange={() => chooseMode("generated")}
                />
                Generar automáticamente
              </label>
              <label>
                <input
                  type="radio"
                  name="passwordMode"
                  checked={draft.passwordMode === "defined"}
                  onChange={() => chooseMode("defined")}
                />
                Definir contraseña temporal
              </label>
            </fieldset>
            {draft.passwordMode === "generated" ? (
              <p className="muted">
                Se genera una contraseña temporal que verás una sola vez; la
                persona deberá cambiarla al iniciar sesión.
              </p>
            ) : (
              <>
                <p className="muted">
                  Escribe una contraseña de 8 a {MAX_TEMPORARY_PASSWORD_LENGTH}{" "}
                  caracteres. No se vuelve a mostrar y la persona deberá
                  cambiarla al iniciar sesión.
                </p>
                <PasswordInput
                  label="Contraseña"
                  autoComplete="new-password"
                  value={draft.temporaryPassword}
                  onChange={(event) =>
                    update({ ...draft, temporaryPassword: event.target.value })
                  }
                  disabled={pending}
                  aria-invalid={passwordMessage !== ""}
                  aria-describedby={passwordMessageId}
                  required
                />
                <FieldMessage id={passwordMessageId} text={passwordMessage} />
                <PasswordInput
                  label="Repetir contraseña"
                  autoComplete="new-password"
                  value={draft.temporaryPasswordRepeat}
                  onChange={(event) =>
                    update({
                      ...draft,
                      temporaryPasswordRepeat: event.target.value,
                    })
                  }
                  disabled={pending}
                  aria-invalid={repeatMessage !== ""}
                  aria-describedby={repeatMessageId}
                  required
                />
                <FieldMessage id={repeatMessageId} text={repeatMessage} />
              </>
            )}
          </>
        ) : null}
        {step === 2 ? (
          <>
            {!fixedOrganization && options.length === 0 ? (
              <div className="empty-state">
                <p>Todavía no hay organizaciones.</p>
                <LinkButton to={paths.newOrganization}>
                  Crear organización
                </LinkButton>
              </div>
            ) : null}
            {!fixedOrganization &&
            options.length > 0 &&
            draft.organizations.length === 0 ? (
              <p className="muted">
                Aún no agregaste organizaciones. Puedes crear el usuario sin
                ninguna o agregar las que correspondan.
              </p>
            ) : null}
            {draft.organizations.map((organization, index) => (
              <OrganizationDraftCard
                key={organization.key}
                index={index}
                memberName={memberName}
                draft={organization}
                organizations={options}
                pickerOptions={listed}
                organizationsTotal={total}
                takenOrganizationIds={chosen}
                fixed={fixedOrganization !== undefined}
                errorMessage={
                  (attempted && step === 2
                    ? organizationErrors[organization.key]?.organization
                    : undefined) ??
                  staleOrganizationMessages[organization.key] ??
                  ""
                }
                disabled={pending}
                open={openOrganizations.keys.has(organization.key)}
                onToggle={() => openOrganizations.toggle(organization.key)}
                onChange={(next) => changeOrganization(organization.key, next)}
                onRemove={() =>
                  update({
                    ...draft,
                    organizations: draft.organizations.filter(
                      ({ key }) => key !== organization.key,
                    ),
                  })
                }
              />
            ))}
            {fixedOrganization || options.length === 0 ? null : (
              <div className="action-row">
                <button
                  type="button"
                  className="secondary-button button-with-icon"
                  disabled={pending || addDisabledReason !== ""}
                  aria-describedby={addDisabledReason ? addReasonId : undefined}
                  onClick={addOrganization}
                >
                  <Plus aria-hidden="true" focusable="false" size={18} />
                  Agregar a una organización
                </button>
                {addDisabledReason ? (
                  <span id={addReasonId} className="muted">
                    {addDisabledReason}
                  </span>
                ) : null}
              </div>
            )}
          </>
        ) : null}
        {step === 3 ? (
          <GroupsStep
            memberName={memberName}
            organizations={draft.organizations.filter(
              ({ organizationId }) => organizationId !== "",
            )}
            options={options}
            fixed={fixedOrganization !== undefined}
            errors={attempted ? groupErrors : staleGroupMessages}
            disabled={pending}
            limitReached={countGroupGrants(draft) >= MAX_TOTAL_GROUP_GRANTS}
            collapsedOrganizations={collapsedSections.keys}
            openGroups={openGroups.keys}
            onToggleOrganization={collapsedSections.toggle}
            onToggleGroup={openGroups.toggle}
            onGroupAdded={(organizationKey, groupKey) => {
              const siblings =
                draft.organizations
                  .find(({ key }) => key === organizationKey)
                  ?.groups.map(({ key }) => key) ?? [];
              openGroups.remove(siblings);
              openGroups.add([groupKey]);
            }}
            onChange={(next) => changeOrganization(next.key, next)}
          />
        ) : null}
        {step === 4 ? (
          <WizardSummary
            draft={draft}
            organizations={options}
            rutLabel={draft.rut}
          />
        ) : null}
      </div>
      {failure?.general ? <p role="alert">{failure.general}</p> : null}
      <div className="action-row">
        {step > 1 ? (
          <button
            key="back"
            type="button"
            className="secondary-button"
            disabled={pending}
            onClick={() => goTo((step - 1) as Step)}
          >
            Atrás
          </button>
        ) : null}
        {step < LAST_STEP ? (
          <button key="next" type="submit" disabled={pending}>
            Siguiente
          </button>
        ) : (
          <button key="create" type="submit" disabled={pending}>
            {pending ? "Creando usuario..." : "Crear usuario"}
          </button>
        )}
      </div>
    </form>
  );
}
