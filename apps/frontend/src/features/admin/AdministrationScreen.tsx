import { useEffect, useRef, useState } from "react";
import { roleLabel, type Profile } from "../profile/ProfileScreen";
import {
  PlatformDiscoveryStatus,
  type PlatformOrganizationsState,
} from "../organizations/OrganizationsScreen";
import {
  canAdministrate,
  membershipKey,
  uuid,
  type AdministrationController,
  type AdministrationIntent,
  type MembershipMethod,
  type MembershipRole,
} from "./administrationOperations";

const actionLabel = (method: MembershipMethod) =>
  method === "POST"
    ? "Agregar membresía"
    : method === "PATCH"
      ? "Cambiar rol"
      : "Retirar membresía";
export function AdministrationScreen({
  profile,
  discovery,
  controller,
  onGroups,
  onRetry,
  onExecute,
  onRetryRead,
}: {
  profile: Profile;
  discovery: PlatformOrganizationsState;
  controller: AdministrationController;
  onGroups: () => void;
  onRetry: () => void;
  onExecute: (intent: AdministrationIntent) => void;
  onRetryRead: (key: string) => void;
}) {
  const { draft, setDraft, operations } = controller;
  const [confirmation, setConfirmation] = useState<AdministrationIntent>();
  const [error, setError] = useState<string>();
  const reviewButton = useRef<HTMLButtonElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const resultRegion = useRef<HTMLElement>(null);
  const key = membershipKey(draft.organizationId, draft.userId);
  const operation = operations.get(key);
  const restoreReviewFocus = useRef(false);
  useEffect(() => {
    if (confirmation) confirmationHeading.current?.focus();
    else if (restoreReviewFocus.current) {
      restoreReviewFocus.current = false;
      reviewButton.current?.focus();
    }
  }, [confirmation]);
  useEffect(() => {
    if (operation && !confirmation) resultRegion.current?.focus();
  }, [operation]);
  if (!canAdministrate(profile))
    return (
      <p role="status">
        Ya no tienes permisos administrativos. Consulta tus organizaciones o tu
        perfil.
      </p>
    );
  const pending = operation?.kind === "pending" || !!operation?.refreshing;
  const locked =
    pending ||
    operation?.kind === "unknown" ||
    (operation?.kind === "confirmed" && operation.refreshFailed);
  const organization =
    discovery.kind === "loaded"
      ? discovery.organizations.find((org) => org.id === draft.organizationId)
      : undefined;
  const cancel = () => {
    restoreReviewFocus.current = true;
    setConfirmation(undefined);
  };
  return (
    <div className="screen-stack administration-screen">
      <section aria-labelledby="admin-capability-title">
        <h2 id="admin-capability-title">Tu capacidad administrativa</h2>
        <p>
          {profile.isPlatformAdministrator
            ? "Administrador de plataforma: puedes gestionar grupos y membresías organizacionales de usuarios existentes."
            : "Administrador de organización: puedes gestionar los grupos de tus organizaciones con rol Administrador, no las membresías organizacionales."}
        </p>
        <p>
          Administrar una organización no otorga acceso a su espacio de trabajo,
          recursos, facturas, políticas ni evidencia.
        </p>
        <button type="button" onClick={onGroups}>
          Administrar grupos en Mis grupos
        </button>
      </section>
      {profile.isPlatformAdministrator ? (
        <section aria-labelledby="admin-memberships-title">
          <h2 id="admin-memberships-title">Membresías organizacionales</h2>
          <p id="membership-help">
            Indica el UUID de una cuenta existente, no su correo ni RUT. Esta
            vista no crea usuarios ni consulta su rol actual o un listado de
            membresías. El servidor protege al último administrador de cada
            organización.
          </p>
          <PlatformDiscoveryStatus state={discovery} onRetry={onRetry} />
          {discovery.kind === "loaded" &&
          discovery.organizations.length === 0 ? (
            <p>No hay organizaciones administrables.</p>
          ) : null}
          <form
            aria-label="Gestionar membresía"
            onSubmit={(event) => {
              event.preventDefault();
              const userId = draft.userId.trim().toLowerCase();
              if (
                !organization ||
                !uuid.test(organization.id) ||
                !uuid.test(userId) ||
                !["ADMIN", "STUDENT"].includes(draft.role)
              ) {
                setError(
                  "Selecciona una organización e ingresa un UUID de usuario válido y un rol permitido.",
                );
                return;
              }
              if (locked) return;
              setError(undefined);
              setConfirmation({
                ...draft,
                userId,
                organizationId: organization.id,
                organizationName: organization.name,
              });
            }}
          >
            <label>
              Organización administrada
              <select
                value={draft.organizationId}
                disabled={pending || !!confirmation}
                onChange={(event) =>
                  setDraft({ ...draft, organizationId: event.target.value })
                }
              >
                <option value="">Selecciona una organización</option>
                {discovery.kind === "loaded"
                  ? discovery.organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name} · {org.id}
                      </option>
                    ))
                  : null}
              </select>
            </label>
            <label>
              UUID de usuario existente
              <input
                aria-describedby="membership-help"
                value={draft.userId}
                disabled={pending || !!confirmation}
                onChange={(event) =>
                  setDraft({ ...draft, userId: event.target.value })
                }
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={pending || !!confirmation}
              onClick={() => setDraft({ ...draft, userId: profile.id })}
            >
              Usar mi identificador
            </button>
            <label>
              Operación de membresía
              <select
                value={draft.method}
                disabled={locked || !!confirmation}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    method: event.target.value as MembershipMethod,
                  })
                }
              >
                <option value="POST">Agregar membresía</option>
                <option value="PATCH">Cambiar rol</option>
                <option value="DELETE">Retirar membresía</option>
              </select>
            </label>
            {draft.method !== "DELETE" ? (
              <label>
                Rol deseado
                <select
                  value={draft.role}
                  disabled={locked || !!confirmation}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      role: event.target.value as MembershipRole,
                    })
                  }
                >
                  <option value="STUDENT">Estudiante</option>
                  <option value="ADMIN">Administrador de organización</option>
                </select>
              </label>
            ) : (
              <p>
                Retirar la membresía también retira a la persona de los grupos
                de esta organización.
              </p>
            )}
            <button
              ref={reviewButton}
              type="submit"
              disabled={locked || !!confirmation || discovery.kind !== "loaded"}
            >
              Revisar operación
            </button>
          </form>
          {error ? <p role="alert">{error}</p> : null}
          {confirmation ? (
            <section
              aria-labelledby="membership-confirm-title"
              className="context-card"
            >
              <h3
                id="membership-confirm-title"
                tabIndex={-1}
                ref={confirmationHeading}
              >
                Confirmar intención administrativa
              </h3>
              <Summary intent={confirmation} />
              <button
                type="button"
                onClick={() => {
                  onExecute(confirmation);
                  setConfirmation(undefined);
                  reviewButton.current?.focus();
                }}
              >
                Confirmar operación
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={cancel}
              >
                Cancelar operación
              </button>
            </section>
          ) : null}
          {operation ? (
            <section
              aria-label="Resultado de membresía"
              className="context-card"
              tabIndex={-1}
              ref={resultRegion}
            >
              <Summary intent={operation.intent} />
              {pending ? (
                <p role="status">
                  {operation.kind === "confirmed"
                    ? "Cambio confirmado por el servidor. Actualizando lecturas; no repitas la operación."
                    : "Validando permisos o enviando operación. No repitas la solicitud."}
                </p>
              ) : operation.kind === "unknown" ? (
                <p role="alert">
                  Resultado no confirmado. Este usuario y organización quedan
                  bloqueados para evitar duplicados. El descubrimiento de grupos
                  no confirma su membresía. Solicita verificación autoritativa
                  al operador fuera de esta vista; no reenvíes la operación.
                </p>
              ) : operation.kind === "confirmed" ? (
                <>
                  <p role="status">
                    Operación confirmada por el servidor.
                    {operation.refreshFailed
                      ? " No fue posible actualizar las lecturas; no repitas la operación."
                      : " Lecturas actualizadas."}
                  </p>
                  {operation.refreshFailed ? (
                    <button type="button" onClick={() => onRetryRead(key)}>
                      Reintentar solo lecturas
                    </button>
                  ) : null}
                </>
              ) : (
                <p role="alert">
                  {operation.status === 409
                    ? "Conflicto: la membresía puede existir o la organización debe conservar un administrador. El servidor no aplicó esta solicitud; verifica la intención antes de intentarlo nuevamente."
                    : operation.status === 403
                      ? "No tienes permisos vigentes para esta operación. No se amplió tu autoridad."
                      : operation.status === 404
                        ? "La organización, el usuario o la membresía no están disponibles."
                        : operation.status === 400
                          ? "El servidor rechazó los datos de la membresía. Corrige la solicitud."
                          : "No fue posible validar los permisos. No se envió la operación; reintenta de forma deliberada."}
                </p>
              )}
            </section>
          ) : null}
          <p>
            El registro de operaciones solo se conserva en memoria durante esta
            sesión y navegación. Recargar la página lo pierde; no garantiza
            idempotencia del servidor. Una nueva sesión reinicia el registro, no
            verifica operaciones anteriores.
          </p>
        </section>
      ) : null}
    </div>
  );
}
function Summary({ intent }: { intent: AdministrationIntent }) {
  return (
    <dl className="context-details">
      <div>
        <dt>Acción</dt>
        <dd>{actionLabel(intent.method)}</dd>
      </div>
      <div>
        <dt>Organización</dt>
        <dd>
          {intent.organizationName} · {intent.organizationId}
        </dd>
      </div>
      <div>
        <dt>Usuario destinatario</dt>
        <dd>{intent.userId}</dd>
      </div>
      {intent.method !== "DELETE" ? (
        <div>
          <dt>Rol solicitado</dt>
          <dd>{roleLabel(intent.role)}</dd>
        </div>
      ) : null}
    </dl>
  );
}
