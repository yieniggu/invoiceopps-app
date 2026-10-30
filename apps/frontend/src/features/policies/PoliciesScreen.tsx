import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useUnauthorized } from "../auth/components/ProtectedSession";
import type { Profile } from "../profile/ProfileScreen";
import {
  parsePolicy,
  PolicyError,
  usePolicyMutations,
  type Policy,
} from "./PolicyMutationsContext";
import {
  contextValue,
  useSharedWorkspace,
  type OwnerContext,
} from "../workspace/WorkspaceContext";
import { protectedFetch } from "../auth/api/protectedFetch";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; status?: number }
  | { kind: "loaded"; policies: Policy[]; manages: boolean };

function httpMessage(status?: number) {
  if (status === 403) return "No tienes permiso para esta operación.";
  if (status === 404)
    return "El espacio de trabajo o la política no está disponible para tu sesión.";
  if (status === 409)
    return "La versión ya existe o cambió. Consulta la lista antes de continuar; no se sobrescribió automáticamente.";
  if (status === 400)
    return "El servidor rechazó los datos. Revisa la versión y el umbral.";
  return "No fue posible completar la consulta. Reintenta la lectura.";
}
function thresholdLabel(value: number) {
  return `${value.toLocaleString("es-CL", { maximumFractionDigits: 20 })} (${(value * 100).toLocaleString("es-CL", { maximumFractionDigits: 18 })} %)`;
}

export function PoliciesScreen({ profile }: { profile: Profile }) {
  const workspace = useSharedWorkspace();
  const context = workspace.selectedContext;
  // Role changes remount authorization reads, not the session-owned mutation ledger.
  const identity = JSON.stringify([profile.id, profile.memberships]);
  return (
    <section className="workspace-content" aria-labelledby="policies-title">
      <h2 id="policies-title">Políticas de negocio versionadas</h2>
      <p>
        Configura el umbral de revisión manual de tu espacio de trabajo. Esto no
        evalúa ni modifica facturas.
      </p>
      {workspace.contexts.length ? (
        <label>
          Propietario
          <select
            ref={workspace.ownerSelectorRef}
            value={workspace.selectedValue}
            onChange={(event) => workspace.setSelectedValue(event.target.value)}
          >
            <option value="" disabled>
              Selecciona un propietario
            </option>
            {workspace.contexts.map((item) => (
              <option key={contextValue(item)} value={contextValue(item)}>
                {item.organizationName} ·{" "}
                {item.ownerType === "user"
                  ? "Individual"
                  : `Grupo: ${item.ownerName}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {context ? (
        <PolicyContext
          key={`${identity}:${contextValue(context)}`}
          profileId={profile.id}
          context={context}
        />
      ) : (
        <p>
          No tienes un espacio de trabajo autorizado para consultar políticas.
        </p>
      )}
    </section>
  );
}

function PolicyContext({
  profileId,
  context,
}: {
  profileId: string;
  context: OwnerContext;
}) {
  const unauthorized = useUnauthorized();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const { get, getDraft, setDraft, execute, reconcile } = usePolicyMutations();
  const key = contextValue(context);
  const operation = get(key);
  const draft = getDraft(key);
  const { selected, version, threshold } = draft;
  const [validationError, setValidationError] = useState<string>();
  const pending = operation?.kind === "pending";
  const unknown = operation?.kind === "unknown";
  const setVersion = (version: string) => setDraft(key, { ...draft, version });
  const setThreshold = (threshold: string) =>
    setDraft(key, { ...draft, threshold });
  const resetDraft = () => setDraft(key, { version: "", threshold: "" });
  const error =
    validationError ??
    (operation?.kind === "rejected"
      ? list.kind === "error"
        ? undefined
        : httpMessage(operation.status)
      : unknown
        ? operation.confirmed
          ? "El cambio fue confirmado, pero no se pudieron verificar los metadatos. Consulta las políticas; no repitas la operación."
          : "El resultado es desconocido. Consulta las políticas antes de volver a guardar. Salir de la pantalla no cancela el procesamiento del servidor."
        : undefined);
  const message =
    operation?.kind === "completed"
      ? operation.source === "read"
        ? "La consulta actual coincide con la intención enviada. Esto no demuestra cancelación ni atribuye el cambio a una solicitud específica."
        : `Política guardada: ${operation.policy.version} · Umbral: ${thresholdLabel(operation.policy.manualReviewThreshold)}. Si la consulta posterior falla, reintenta solo la lectura; no repitas la operación.`
      : undefined;
  const alive = useRef(false);
  const read = useRef<AbortController | null>(null);
  const params = new URLSearchParams({
    organizationId: context.organizationId,
    ownerType: context.ownerType,
    ownerId: context.ownerId,
  }).toString();

  const confirmContext = useCallback(
    async (isCurrent: () => boolean, signal?: AbortSignal) => {
      const response = await protectedFetch("/api/v1/auth/profile", {
        credentials: "same-origin",
        signal,
      });
      if (!isCurrent()) return null;
      if (!response.ok) throw new PolicyError(response.status);
      const result = (await response.json()) as { profile: Profile };
      if (!isCurrent()) return null;
      const member = result.profile.memberships.find(
        ({ organization }) => organization.id === context.organizationId,
      );
      if (
        result.profile.id !== profileId ||
        !member ||
        (context.ownerType === "user" && context.ownerId !== result.profile.id)
      )
        throw new PolicyError(404);
      if (context.ownerType === "group") {
        const groupsResponse = await protectedFetch("/api/v1/groups", {
          credentials: "same-origin",
          signal,
        });
        if (!isCurrent()) return null;
        if (!groupsResponse.ok) throw new PolicyError(groupsResponse.status);
        const { groups } = (await groupsResponse.json()) as {
          groups: Array<{ id: string; organization: { id: string } }>;
        };
        if (!isCurrent()) return null;
        if (
          !groups.some(
            (group) =>
              group.id === context.ownerId &&
              group.organization.id === context.organizationId,
          )
        )
          throw new PolicyError(404);
      }
      return context.ownerType === "user" || member.role === "ADMIN";
    },
    [context.organizationId, context.ownerId, context.ownerType, profileId],
  );

  const refresh = useCallback(async () => {
    const observed = get(key);
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const isCurrent = () =>
      alive.current &&
      read.current === controller &&
      !controller.signal.aborted;
    setList({ kind: "loading" });
    try {
      const manages = await confirmContext(isCurrent, controller.signal);
      if (!isCurrent() || manages === null) return;
      const response = await protectedFetch(
        `/api/v1/business-policies?${params}`,
        {
          credentials: "same-origin",
          signal: controller.signal,
        },
      );
      if (!isCurrent()) return;
      if (!response.ok) throw new PolicyError(response.status);
      const result = (await response.json()) as { policies: unknown[] };
      if (!isCurrent()) return;
      if (!Array.isArray(result.policies))
        throw new Error("Invalid policy list");
      const policies = result.policies.map(parsePolicy);
      setList({ kind: "loaded", policies, manages });
      reconcile(key, observed, policies);
    } catch (failure) {
      if (!isCurrent()) return;
      const status =
        failure instanceof PolicyError ? failure.status : undefined;
      if (status === 401) {
        unauthorized();
        return;
      }
      setList({ kind: "error", status });
    } finally {
      if (isCurrent()) read.current = null;
    }
  }, [confirmContext, params, unauthorized, get, key, reconcile]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, [refresh]);

  const lastOperation = useRef(operation);
  useEffect(() => {
    if (lastOperation.current === operation) return;
    lastOperation.current = operation;
    if (operation?.kind === "completed" && operation.source === "response")
      void refresh();
  }, [operation, refresh]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !alive.current ||
      pending ||
      unknown ||
      list.kind !== "loaded" ||
      !list.manages
    )
      return;
    const normalized = threshold.trim();
    const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)
      ? Number(normalized)
      : NaN;
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
      setValidationError(
        "Ingresa un umbral entre 0 y 1, ambos incluidos. Usa punto decimal, no coma ni porcentaje.",
      );
      return;
    }
    const targetVersion = selected ?? version.trim();
    if (!targetVersion || targetVersion.length > 120) {
      setValidationError("Ingresa una versión de 1 a 120 caracteres.");
      return;
    }
    setValidationError(undefined);
    const outcome = await execute(
      key,
      {
        path: `/api/v1/business-policies${selected === undefined ? "" : `/${encodeURIComponent(selected)}`}?${params}`,
        method: selected === undefined ? "POST" : "PATCH",
        policy: { version: targetVersion, manualReviewThreshold: numeric },
      },
      confirmContext,
    );
    // Session-owned completion persists, but an obsolete view cannot publish or expire B.
    if (!alive.current || !outcome) return;
    if (
      (outcome.kind === "unknown" || outcome.kind === "rejected") &&
      outcome.status === 401
    ) {
      unauthorized();
      return;
    }
    if (
      outcome.kind === "rejected" &&
      (outcome.preflight || outcome.status === 403 || outcome.status === 404)
    )
      setList({ kind: "error", status: outcome.status });
  };

  return (
    <div className="screen-stack">
      <p>
        {context.organizationName} ·{" "}
        {context.ownerType === "user"
          ? "Trabajo individual"
          : `Grupo: ${context.ownerName}`}
      </p>
      <p>
        En la evaluación, una probabilidad mayor o igual al umbral deriva a
        revisión manual. El umbral se envía de 0 a 1: 0.8 equivale a 80 %, no a
        80. Usa punto decimal; la coma no se admite.
      </p>
      <p>
        Consulta una versión aquí. No se selecciona ni aplica automáticamente a
        las facturas.
      </p>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {operation && (pending || unknown) ? (
        <section aria-label="Operación de política">
          <h3>
            {pending
              ? "Escritura pendiente en este espacio de trabajo"
              : "Escritura por verificar en este espacio de trabajo"}
          </h3>
          <p>
            Intención:{" "}
            {operation.intent.method === "PATCH" ? "editar" : "crear"} ·
            Versión: {operation.intent.policy.version} · Umbral:{" "}
            {thresholdLabel(operation.intent.policy.manualReviewThreshold)}
          </p>
          <p>
            El espacio de trabajo permanece bloqueado para nuevas escrituras
            hasta recibir el resultado o verificar una lectura posterior que
            coincida con la intención.
          </p>
          {unknown && operation.checked ? (
            <p>
              Compara la lista actual con la intención enviada. Aún no coincide;
              el resultado sigue sin resolver y guardar permanece bloqueado. La
              consulta no prueba cancelación.
            </p>
          ) : null}
        </section>
      ) : null}
      {pending ? (
        <p role="status">
          Guardando política. Navegar no cancela una escritura ya recibida por
          el servidor.
        </p>
      ) : null}
      {list.kind === "loading" ? (
        <p role="status">Cargando políticas...</p>
      ) : null}
      {list.kind === "error" ? (
        <>
          <p role="alert">
            No fue posible cargar las políticas. {httpMessage(list.status)}
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void refresh()}
          >
            Reintentar políticas
          </button>
        </>
      ) : null}
      {list.kind === "loaded" ? (
        <>
          <div
            className="action-row"
            role="group"
            aria-label="Consulta de políticas"
          >
            <button
              type="button"
              disabled={pending}
              onClick={() => void refresh()}
            >
              {unknown ? "Consultar políticas" : "Actualizar políticas"}
            </button>
          </div>
          {!list.manages ? (
            <p>
              Solo lectura. Las políticas grupales requieren rol de
              administrador de la organización para crear o editar; ser miembro
              del grupo o administrador de plataforma no concede ese permiso.
            </p>
          ) : null}
          {list.policies.length === 0 ? (
            <p>No hay políticas para este propietario.</p>
          ) : (
            <ul className="card-list" aria-label="Listado de políticas">
              {list.policies.map((item) => (
                <li key={item.version} className="context-card">
                  <h3>{item.version}</h3>
                  <p>
                    Umbral de revisión manual (0 a 1):{" "}
                    {thresholdLabel(item.manualReviewThreshold)}
                  </p>
                  {list.manages ? (
                    <button
                      type="button"
                      disabled={pending || unknown}
                      onClick={() => {
                        setDraft(key, {
                          selected: item.version,
                          version: item.version,
                          threshold: String(item.manualReviewThreshold),
                        });
                        setValidationError(undefined);
                      }}
                    >
                      Editar {item.version}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {list.manages ? (
            <form
              aria-labelledby="policy-form-title"
              noValidate
              onSubmit={(event) => void save(event)}
            >
              <h3 id="policy-form-title">
                {selected === undefined ? "Crear política" : "Editar política"}
              </h3>
              <label>
                Versión de política
                <input
                  maxLength={120}
                  value={version}
                  readOnly={selected !== undefined}
                  disabled={pending || unknown}
                  aria-describedby="policy-version-help"
                  onChange={(event) => setVersion(event.target.value)}
                />
              </label>
              <p id="policy-version-help">
                De 1 a 120 caracteres. Se eliminan espacios al inicio y al final
                al crear. La versión no se puede cambiar al editar.
              </p>
              <label>
                Umbral de revisión manual (0 a 1)
                <input
                  inputMode="decimal"
                  value={threshold}
                  disabled={pending || unknown}
                  aria-describedby="policy-threshold-help"
                  onChange={(event) => setThreshold(event.target.value)}
                />
              </label>
              <p id="policy-threshold-help">
                0 y 1 son válidos. Ejemplo: 0.8 (80 %). No ingreses porcentajes
                ni coma decimal.
              </p>
              <div
                className="action-row"
                role="group"
                aria-label="Acciones de política"
              >
                <button type="submit" disabled={pending || unknown}>
                  {pending
                    ? "Guardando política..."
                    : selected === undefined
                      ? "Crear política"
                      : "Guardar política"}
                </button>
                {selected !== undefined ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending || unknown}
                    onClick={() => {
                      resetDraft();
                      setValidationError(undefined);
                    }}
                  >
                    Cancelar edición
                  </button>
                ) : null}
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
