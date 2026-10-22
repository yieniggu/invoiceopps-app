import { useState, type ReactNode } from "react";
import {
  contextValue,
  useSharedWorkspace,
  type OwnerContext,
} from "../workspace/WorkspaceContext";
import {
  parseRecords,
  parseBatches,
  parseRecordDetail,
  parseBatchDetail,
  parseProof,
  readMessage,
  useEvidenceRead,
  type ReadState,
  type EvidenceRecord,
  type EvidenceBatch,
} from "./evidenceRead";

type Kind = "records" | "batches";
export function EvidenceScreen() {
  const workspace = useSharedWorkspace();
  const context = workspace.selectedContext;
  return (
    <section className="workspace-content" aria-labelledby="evidence-title">
      <h2 id="evidence-title">Consulta de evidencia</h2>
      <p>
        Solo lectura de registros y lotes existentes. No crea lotes, firma ni
        consulta blockchain.
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
        <EvidenceContext key={contextValue(context)} context={context} />
      ) : (
        <p>No tienes un contexto autorizado para consultar evidencia.</p>
      )}
    </section>
  );
}
function EvidenceContext({ context }: { context: OwnerContext }) {
  const [kind, setKind] = useState<Kind>("records");
  const [filter, setFilter] = useState("");
  const params = new URLSearchParams({
    organizationId: context.organizationId,
    ownerType: context.ownerType,
    ownerId: context.ownerId,
  }).toString();
  return (
    <div className="screen-stack">
      <div className="action-row" role="group" aria-label="Tipo de evidencia">
        <button
          type="button"
          aria-pressed={kind === "records"}
          onClick={() => {
            setKind("records");
            setFilter("");
          }}
        >
          Registros
        </button>
        <button
          type="button"
          aria-pressed={kind === "batches"}
          onClick={() => {
            setKind("batches");
            setFilter("");
          }}
        >
          Lotes
        </button>
      </div>
      <EvidenceList
        key={`${kind}:${filter}`}
        kind={kind}
        params={params}
        initialFilter={filter}
        onBatches={(id) => {
          setKind("batches");
          setFilter(id);
        }}
      />
    </div>
  );
}
function Feedback<T>({
  state,
  retry,
  children,
}: {
  state: ReadState<T>;
  retry: () => void;
  children: (data: T) => ReactNode;
}) {
  if (state.kind === "loading")
    return <p role="status">Cargando evidencia...</p>;
  if (state.kind === "error")
    return (
      <div>
        <p role="alert">{readMessage(state)}</p>
        {state.status !== 401 ? (
          <button type="button" onClick={retry}>
            Reintentar lectura
          </button>
        ) : null}
      </div>
    );
  return state.kind === "loaded" ? children(state.data) : null;
}
function EvidenceList({
  kind,
  params,
  initialFilter,
  onBatches,
}: {
  kind: Kind;
  params: string;
  initialFilter: string;
  onBatches: (id: string) => void;
}) {
  const [draft, setDraft] = useState(initialFilter);
  const [recordId, setRecordId] = useState(initialFilter);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [validation, setValidation] = useState<string>();
  const query = new URLSearchParams(params);
  query.set("limit", "50");
  if (recordId) query.set("recordId", recordId);
  if (cursor) query.set("cursor", cursor);
  // Remount the page owner for every query, so the previous page cannot render or
  // expire a later page while its body is still resolving.
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const id = draft.trim();
          if (
            id &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              id,
            )
          ) {
            setValidation(
              "Ingresa un UUID de registro válido o deja el campo vacío.",
            );
            return;
          }
          setValidation(undefined);
          setRecordId(id);
          setCursor(null);
          setSelection(null);
        }}
      >
        <label>
          Identificador de registro
          <input
            value={draft}
            maxLength={36}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <p>
          Filtro exacto por UUID. En Lotes muestra solo los lotes que contienen
          ese registro.
        </p>
        <button type="submit">Filtrar registros</button>
        {validation ? <p role="alert">{validation}</p> : null}
      </form>
      <EvidencePageView
        key={query.toString()}
        kind={kind}
        path={`/evidence-${kind}?${query}`}
        onSelect={setSelection}
        onNext={(value) => {
          setSelection(null);
          setCursor(value);
        }}
        onFirst={() => {
          setSelection(null);
          setCursor(null);
        }}
        hasCursor={cursor !== null}
      />
      {selection ? (
        <section aria-label="Detalle de evidencia">
          <button type="button" onClick={() => setSelection(null)}>
            Cerrar detalle
          </button>
          {kind === "records" ? (
            <RecordDetail
              key={selection}
              id={selection}
              params={params}
              onBatches={onBatches}
            />
          ) : (
            <BatchDetail key={selection} id={selection} params={params} />
          )}
        </section>
      ) : null}
    </>
  );
}
function EvidencePageView({
  kind,
  path,
  onSelect,
  onNext,
  onFirst,
  hasCursor,
}: {
  kind: Kind;
  path: string;
  onSelect: (id: string | null) => void;
  onNext: (cursor: string) => void;
  onFirst: () => void;
  hasCursor: boolean;
}) {
  const { state, load } = useEvidenceRead(
    path,
    kind === "records" ? parseRecords : parseBatches,
  );
  return (
    <section
      aria-label={
        kind === "records" ? "Registros de evidencia" : "Lotes de evidencia"
      }
    >
      <h3>
        {kind === "records" ? "Registros existentes" : "Lotes existentes"}
      </h3>
      <p>
        Metadatos sin verificar en el listado. Abre un detalle para solicitar la
        verificación nativa al servidor.
      </p>
      <div className="action-row">
        <button
          type="button"
          disabled={state.kind === "loading"}
          onClick={() => {
            onSelect(null);
            void load();
          }}
        >
          Actualizar listado
        </button>
        {hasCursor ? (
          <button type="button" onClick={onFirst}>
            Primera página
          </button>
        ) : null}
      </div>
      <Feedback state={state} retry={() => void load()}>
        {(page) => (
          <>
            <p role="status">
              {page.items.length} {kind === "records" ? "registros" : "lotes"}{" "}
              en esta página. Máximo 50.
            </p>
            {page.items.length ? (
              <ul className="card-list">
                {page.items.map((item) => (
                  <li key={item.id} className="context-card">
                    <h4>{item.id}</h4>
                    <Metadata item={item} />
                    <button type="button" onClick={() => onSelect(item.id)}>
                      Ver {kind === "records" ? "registro" : "lote"} {item.id}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                No hay {kind === "records" ? "registros" : "lotes"} para esta
                consulta.
              </p>
            )}
            {page.nextCursor ? (
              <button type="button" onClick={() => onNext(page.nextCursor!)}>
                Página siguiente
              </button>
            ) : null}
          </>
        )}
      </Feedback>
    </section>
  );
}
function Metadata({ item }: { item: EvidenceRecord | EvidenceBatch }) {
  const date = new Date(item.createdAt);
  return (
    <dl>
      <div>
        <dt>Fecha de persistencia</dt>
        <dd>
          {Number.isNaN(date.getTime())
            ? "Fecha no disponible"
            : date.toLocaleString("es", { timeZone: "UTC" }) + " UTC"}
        </dd>
      </div>
      {"leafHash" in item ? (
        <>
          <div>
            <dt>Evento de decisión</dt>
            <dd>{item.decisionEventId}</dd>
          </div>
          <div>
            <dt>Referencia interna de factura</dt>
            <dd>{item.invoiceRecordId}</dd>
          </div>
          <div>
            <dt>Versión de evidencia</dt>
            <dd>{item.evidenceVersion}</dd>
          </div>
          <div>
            <dt>Canonización</dt>
            <dd>{item.canonicalVersion}</dd>
          </div>
          <div>
            <dt>Hash de hoja (Keccak-256)</dt>
            <dd>
              <code>{item.leafHash}</code>
            </dd>
          </div>
        </>
      ) : (
        <>
          <div>
            <dt>Raíz Merkle (Keccak-256)</dt>
            <dd>
              <code>{item.rootHash}</code>
            </dd>
          </div>
          <div>
            <dt>Hojas</dt>
            <dd>{item.leafCount}</dd>
          </div>
          <div>
            <dt>Política Merkle</dt>
            <dd>{item.policyVersion}</dd>
          </div>
        </>
      )}
    </dl>
  );
}
function VerifiedNotice() {
  return (
    <p role="status">
      Integridad verificada por el servidor con la implementación nativa. El
      navegador no realizó una verificación criptográfica independiente. Esto no
      acredita anclaje ni finalidad blockchain; un recibo no equivale a
      finalidad.
    </p>
  );
}
function RecordDetail({
  id,
  params,
  onBatches,
}: {
  id: string;
  params: string;
  onBatches: (id: string) => void;
}) {
  const { state, load } = useEvidenceRead(
    `/evidence-records/${encodeURIComponent(id)}?${params}`,
    parseRecordDetail,
  );
  return (
    <>
      <h3>Detalle del registro</h3>
      <Feedback state={state} retry={() => void load()}>
        {(record) => (
          <>
            <h4>{record.id}</h4>
            <Metadata item={record} />
            <VerifiedNotice />
            <button type="button" onClick={() => onBatches(record.id)}>
              Ver lotes de este registro
            </button>
          </>
        )}
      </Feedback>
    </>
  );
}
function BatchDetail({ id, params }: { id: string; params: string }) {
  const { state, load } = useEvidenceRead(
    `/evidence-batches/${encodeURIComponent(id)}?${params}`,
    parseBatchDetail,
  );
  const [recordId, setRecordId] = useState<string | null>(null);
  return (
    <>
      <h3>Detalle del lote</h3>
      <Feedback state={state} retry={() => void load()}>
        {(batch) => (
          <>
            <h4>{batch.id}</h4>
            <Metadata item={batch} />
            <VerifiedNotice />
            <h4>Miembros del lote (máximo 256)</h4>
            <ul className="card-list">
              {batch.items!.map((item) => (
                <li key={item.recordId} className="context-card">
                  <p>
                    Índice {item.leafIndex} · {item.recordId}
                  </p>
                  <button
                    type="button"
                    onClick={() => setRecordId(item.recordId)}
                  >
                    Consultar prueba de {item.recordId}
                  </button>
                </li>
              ))}
            </ul>
            {recordId ? (
              <ProofDetail
                key={recordId}
                batchId={id}
                recordId={recordId}
                params={params}
              />
            ) : null}
          </>
        )}
      </Feedback>
    </>
  );
}
function ProofDetail({
  batchId,
  recordId,
  params,
}: {
  batchId: string;
  recordId: string;
  params: string;
}) {
  const { state, load } = useEvidenceRead(
    `/evidence-batches/${encodeURIComponent(batchId)}/proofs/${encodeURIComponent(recordId)}?${params}`,
    parseProof,
  );
  return (
    <section aria-label="Prueba Merkle">
      <h4>Prueba de pertenencia</h4>
      <Feedback state={state} retry={() => void load()}>
        {(value) => (
          <>
            <dl>
              <div>
                <dt>Lote</dt>
                <dd>{value.batchId}</dd>
              </div>
              <div>
                <dt>Registro</dt>
                <dd>{value.recordId}</dd>
              </div>
              <div>
                <dt>Hash de hoja</dt>
                <dd>
                  <code>{value.leafHash}</code>
                </dd>
              </div>
              <div>
                <dt>Raíz</dt>
                <dd>
                  <code>{value.rootHash}</code>
                </dd>
              </div>
              <div>
                <dt>Posición</dt>
                <dd>
                  {value.leafIndex} de {value.leafCount} hojas (índice desde 0)
                </dd>
              </div>
              <div>
                <dt>Política</dt>
                <dd>{value.policyVersion}</dd>
              </div>
            </dl>
            <VerifiedNotice />
            {value.proof.length ? (
              <div
                className="workspace-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Pasos de la prueba Merkle"
              >
                <table>
                  <caption>Hermanos en orden desde la hoja</caption>
                  <thead>
                    <tr>
                      <th scope="col">Paso</th>
                      <th scope="col">Lado del hermano</th>
                      <th scope="col">Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {value.proof.map(([side, hash], index) => (
                      <tr key={index}>
                        <th scope="row">{index + 1}</th>
                        <td>{side === "left" ? "Izquierda" : "Derecha"}</td>
                        <td>
                          <code>{hash}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>Lote de una hoja: no requiere hermanos.</p>
            )}
          </>
        )}
      </Feedback>
    </section>
  );
}
