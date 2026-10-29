import { useRef, useState } from "react";
import { Link, useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { DataTable, type DataColumn } from "../../../components/DataTable";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { fromApiRut } from "../../../lib/rut";
import { isUuid } from "../../../lib/uuid";
import { isApiError } from "../../auth/api/apiError";
import { useIdentityId } from "../../auth/hooks/useSession";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { memberRoleLabel } from "../../orgs/types/roles";
import { permissionRatio } from "../../permissions/types";
import { usePresentIssuedCredential } from "../../users/components/IssuedCredentialProvider";
import { accountStatusLabel, activityLabel } from "../../users/presentation";
import { EditAdminUserDialog } from "../components/EditAdminUserDialog";
import {
  useAdminUserQuery,
  useResetAdminUserPassword,
  useSetAdminUserDeactivation,
} from "../hooks/useAdminUsers";
import type { AdminUser, AdminUserMembership } from "../types";

const ACTION_MESSAGES = {
  SELF_ACTION_FORBIDDEN:
    "No puedes realizar esta acción sobre tu propia cuenta.",
  LAST_ADMIN_REQUIRED:
    "No puedes desactivar a la última persona administradora de la plataforma.",
};

/** One person of the platform: data, administrative actions, memberships. */
export function AdminUserScreen() {
  const { userId = "" } = useParams();
  return <AdminUserLoader key={userId} userId={userId} />;
}

function AdminUserLoader({ userId }: { userId: string }) {
  // A malformed id is no person: no request (the server answers 404).
  const wellFormed = isUuid(userId);
  const query = useAdminUserQuery(userId, wellFormed);
  const back = <BackLink to={paths.adminUsers()}>Usuarios</BackLink>;

  if (
    !wellFormed ||
    (query.isError &&
      query.data === undefined &&
      isApiError(query.error) &&
      query.error.status === 404)
  )
    return (
      <NotFoundScreen description="No encontramos a esa persona en la plataforma." />
    );
  if (!query.data) {
    return (
      <div className="screen-stack">
        {back}
        <PageHeader title="Usuario" />
        <QueryFeedback
          query={query}
          loading="Cargando usuario..."
          error="No fue posible cargar al usuario."
          retryLabel="Reintentar usuario"
        />
      </div>
    );
  }
  return (
    <div className="screen-stack">
      {back}
      <AdminUserView
        user={query.data.user}
        memberships={query.data.memberships}
        query={query}
      />
    </div>
  );
}

const MEMBERSHIP_COLUMNS = (
  userId: string,
): DataColumn<AdminUserMembership & { id: string }>[] => [
  {
    header: "Organización",
    cell: ({ organization }) => (
      <Link to={paths.organizationMember(organization.id, userId)}>
        {organization.name}
      </Link>
    ),
  },
  { header: "Rol", cell: ({ role }) => memberRoleLabel(role) },
  {
    header: "Permisos",
    cell: ({ permissions }) => `${permissionRatio(permissions)} permisos`,
  },
  {
    header: "Grupos",
    cell: ({ groups }) =>
      groups.length > 0
        ? groups
            .map(
              ({ group, permissions }) =>
                `${group.name} (${permissionRatio(permissions)})`,
            )
            .join(", ")
        : "Sin grupos",
  },
];

function AdminUserView({
  user,
  memberships,
  query,
}: {
  user: AdminUser;
  memberships: AdminUserMembership[];
  query: Parameters<typeof QueryFeedback>[0]["query"];
}) {
  const identityId = useIdentityId();
  const isSelf = user.id === identityId;
  const present = usePresentIssuedCredential();
  const [editing, setEditing] = useState(false);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const reset = useResetAdminUserPassword(user, (credential) =>
    present(credential, resetTrigger),
  );
  const deactivation = useSetAdminUserDeactivation(user.id);
  const disabled = user.disabledAt !== null;

  return (
    <>
      <PageHeader
        eyebrow="Administración"
        title={user.name}
        description={`RUT ${fromApiRut(user.rut)}`}
        action={
          <button
            ref={editTrigger}
            type="button"
            onClick={() => setEditing(true)}
          >
            Editar
          </button>
        }
      />
      <QueryFeedback
        query={query}
        loading=""
        error=""
        staleError="No fue posible actualizar los datos del usuario; lo que ves puede estar desactualizado."
        retryLabel="Reintentar usuario"
      />
      <section aria-labelledby="admin-user-data-title">
        <h2 id="admin-user-data-title">Datos</h2>
        <dl className="summary-list">
          <div>
            <dt>Nombre</dt>
            <dd>{user.name}</dd>
          </div>
          <div>
            <dt>RUT</dt>
            <dd>{fromApiRut(user.rut)}</dd>
          </div>
          <div>
            <dt>Correo</dt>
            <dd>{user.email ?? "Sin correo"}</dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>{accountStatusLabel(disabled)}</dd>
          </div>
          <div>
            <dt>Actividad</dt>
            <dd>{activityLabel(user.recentlyActive)}</dd>
          </div>
          <div>
            <dt>Cambio de contraseña pendiente</dt>
            <dd>{user.mustChangePassword ? "Sí" : "No"}</dd>
          </div>
          {user.isPlatformAdministrator ? (
            <div>
              <dt>Plataforma</dt>
              <dd>Administrador de la plataforma</dd>
            </div>
          ) : null}
        </dl>
      </section>
      <section aria-labelledby="admin-user-actions-title">
        <h2 id="admin-user-actions-title">Acciones</h2>
        {isSelf ? (
          <p>
            Esta es tu propia cuenta: no puedes restablecer tu contraseña ni
            desactivarla desde aquí.
          </p>
        ) : (
          <>
            <div className="action-row">
              <ConfirmAction
                label="Restablecer contraseña"
                confirmLabel="Confirmar restablecimiento"
                triggerRef={resetTrigger}
                disabled={reset.isPending}
                onConfirm={() => reset.mutate()}
              />
              <ConfirmAction
                label={disabled ? "Reactivar" : "Desactivar"}
                confirmLabel={
                  disabled
                    ? "Confirmar reactivación"
                    : "Confirmar desactivación"
                }
                disabled={deactivation.isPending}
                onConfirm={() => deactivation.mutate(!disabled)}
              />
            </div>
            <p className="field-hint">
              Restablecer la contraseña genera una clave temporal que se muestra
              una sola vez; la persona deberá cambiarla al iniciar sesión.
            </p>
            <MutationFeedback
              isError={reset.isError}
              error={reset.error}
              isSuccess={false}
              success=""
              fallback="No fue posible restablecer la contraseña. Intenta nuevamente."
              messages={ACTION_MESSAGES}
              focusOnError
            />
            <MutationFeedback
              isError={deactivation.isError}
              error={deactivation.error}
              isSuccess={deactivation.isSuccess}
              success={
                deactivation.variables
                  ? "Cuenta desactivada."
                  : "Cuenta reactivada."
              }
              fallback="No fue posible cambiar el estado de la cuenta. Intenta nuevamente."
              messages={ACTION_MESSAGES}
              focusOnError
            />
          </>
        )}
      </section>
      <section aria-labelledby="admin-user-memberships-title">
        <h2 id="admin-user-memberships-title">Organizaciones</h2>
        {memberships.length === 0 ? (
          <p>Esta persona no pertenece a ninguna organización.</p>
        ) : (
          <>
            <p className="field-hint">
              Para cambiar rol, permisos o grupos, abre la organización.
            </p>
            <DataTable
              label="Organizaciones de la persona"
              rows={memberships.map((entry) => ({
                ...entry,
                id: entry.organization.id,
              }))}
              columns={MEMBERSHIP_COLUMNS(user.id)}
            />
          </>
        )}
      </section>
      {editing ? (
        <EditAdminUserDialog
          user={user}
          isSelf={isSelf}
          returnFocusTo={editTrigger}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}
