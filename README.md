# InvoiceOps App

Scaffold inicial de la aplicación InvoiceOps. Incluye un backend Express con
TypeScript, un frontend React con Vite y PostgreSQL para desarrollo local.

## Requisitos

- Node.js 24 o superior.
- pnpm 11 o superior.
- Docker Desktop con Docker Compose, para ejecutar el entorno completo.

## Configuración local

1. Crea un archivo `.env` local con las variables requeridas. No incluyas este
   archivo en el control de versiones.

   | Variable             | Propósito                                              | Ejemplo local                                                                                        | Requerida                                                                 |
   | -------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
   | `POSTGRES_USER`      | Usuario que PostgreSQL crea para el entorno local      | `invoiceops`                                                                                         | No, Compose usa `invoiceops` por defecto                                  |
   | `POSTGRES_PASSWORD`  | Contraseña local del usuario de PostgreSQL             | `replace-with-a-local-password`                                                                      | Sí, usa una contraseña propia y no la publiques                           |
   | `POSTGRES_DB`        | Base de datos inicial de PostgreSQL                    | `invoiceops`                                                                                         | No, Compose usa `invoiceops` por defecto                                  |
   | `POSTGRES_TEST_PORT` | Puerto del host para PostgreSQL de integración         | `5436`                                                                                               | No, Compose usa `5436` por defecto                                        |
   | `BACKEND_PORT`       | Puerto del host para el backend de Compose             | `3000`                                                                                               | No, Compose usa `3000` por defecto                                        |
   | `FRONTEND_PORT`      | Puerto del host para el frontend de Compose            | `5173`                                                                                               | No, Compose usa `5173` por defecto                                        |
   | `DATABASE_URL`       | Cadena de conexión que usa el backend fuera de Compose | `postgresql://invoiceops:replace-with-a-local-password@localhost:5432/invoiceops?schema=public`      | Sí para ejecutar el backend localmente; Compose la construye internamente |
   | `TEST_DATABASE_URL`  | Cadena exclusiva de las pruebas de integración         | `postgresql://invoiceops:replace-with-a-local-password@localhost:5436/invoiceops_test?schema=public` | Sí para integración; debe terminar exactamente en `invoiceops_test`       |
   | `MODEL_API_URL`      | URL base del proveedor de inferencia                   | Sin valor por defecto                                                                                | Sólo para inferencia live; debe configurarse junto a `MODEL_API_MODEL_ID` |
   | `MODEL_API_MODEL_ID` | Identificador del modelo a invocar                     | Sin valor por defecto                                                                                | Sólo para inferencia live; debe configurarse junto a `MODEL_API_URL`      |

   Usa valores de ejemplo solo en tu equipo. La contraseña de ejemplo no es un
   secreto válido ni debe reutilizarse fuera del desarrollo local.

2. Instala las dependencias:

   ```bash
   pnpm install
   ```

3. Genera el cliente Prisma:

   ```bash
   pnpm generate
   ```

4. Arranca PostgreSQL:

   ```bash
   docker compose up -d db
   ```

5. Aplica las migraciones locales de PostgreSQL con `DATABASE_URL` configurada:

   ```bash
   pnpm --filter @invoiceops/backend exec prisma migrate dev
   ```

   Las migraciones son explícitas: el backend, Docker Compose y el arranque no
   ejecutan cambios de esquema automáticamente.

6. En terminales separadas, inicia backend y frontend:

   ```bash
   DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d '=' -f2-)" pnpm --filter @invoiceops/backend dev
   pnpm --filter @invoiceops/frontend dev
   ```

También puedes iniciar ambos procesos de desarrollo con `pnpm dev` si
`DATABASE_URL` está disponible en tu entorno.

## Entorno completo con Compose

```bash
docker compose up --build
```

El primer arranque construye las imágenes y crea el volumen local de PostgreSQL.

## URLs y checks

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`
- Liveness: `http://localhost:3000/health/live`
- Readiness de PostgreSQL: `http://localhost:3000/health/ready`

`/health/live` confirma que el proceso HTTP está disponible. `/health/ready`
consulta PostgreSQL y devuelve `503` con una respuesta segura si la base de datos
no está disponible.

Antes de entregar cambios, ejecuta:

```bash
pnpm test
```

`pnpm test` ejecuta solamente pruebas unitarias y de contrato de esquema; no
comprueba restricciones ni persistencia de PostgreSQL.

## Pruebas de integración PostgreSQL

Las pruebas de integración usan exclusivamente la base `invoiceops_test` del
servicio Compose `db-test`. Ese servicio está bajo el perfil `test`, usa el
puerto local `5436` y un volumen propio; no se inicia con `docker compose up` ni
comparte la base ni el volumen de la aplicación. Configura `TEST_DATABASE_URL`
en `.env` con el valor de `.env.example`, inicia el servicio aislado, aplica las
migraciones y ejecuta el gate explícito:

```bash
docker compose --profile test up -d db-test
export TEST_DATABASE_URL="$(grep '^TEST_DATABASE_URL=' .env | cut -d '=' -f2-)"
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @invoiceops/backend exec prisma migrate deploy
pnpm test:integration
```

`pnpm test:integration` falla controladamente si `TEST_DATABASE_URL` no está
definida o no apunta a `invoiceops_test`, antes de ejecutar cualquier
`deleteMany`. Estas pruebas limpian tablas: nunca uses `DATABASE_URL`, la base
`invoiceops` del servicio `db`, una base compartida ni una base con datos que
deban conservarse.

Cuando finalice, detén y elimina solo el contenedor de prueba con `docker
compose --profile test rm --stop --force db-test`. Este comando no elimina
volúmenes. Después ejecuta los gates restantes:

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm format:check
docker compose config
```

## Rollout de grupos organizacionales

La migración `20260911170000_add_organization_groups` es un cambio aditivo: crea
`Group` y `GroupMembership`, sus índices y sus claves foráneas compuestas. Antes
de desplegar una versión de la aplicación que use grupos, aplica el esquema con
la misma `DATABASE_URL` del entorno objetivo:

```bash
pnpm --filter @invoiceops/backend exec prisma migrate deploy
```

Las versiones anteriores de la aplicación continúan siendo compatibles mientras
la migración ya aplicada conserve las tablas existentes. La versión con grupos
requiere que esa migración esté desplegada antes de atender tráfico; no habilites
las rutas de grupos contra un esquema anterior.

El rollback seguro y no destructivo consiste en revertir la aplicación a la
versión previa, manteniendo las nuevas tablas y sus datos sin usarlos. No
ejecutes `DROP TABLE` como rollback automático: eliminar `Group` o
`GroupMembership` con datos requiere una decisión operativa explícita, respaldo
verificado y un plan de recuperación aprobado.

## Parada

```bash
docker compose down
```

El comando anterior conserva los datos locales. Para borrar explícitamente el
volumen de PostgreSQL, usa `docker compose down -v` solo si ya no necesitas esos
datos.

## Alcance actual

### Autenticación

El backend expone `POST /auth/signup`, `POST /auth/login` y `POST /auth/logout`. El modo se define
con `AUTH_MODE=open` (valor por defecto) o `AUTH_MODE=allowlist`. En el modo
restringido, un operador debe registrar el RUT normalizado y la organización en
`AuthorizedUserOrganization` antes del registro; un RUT puede estar autorizado
para varias organizaciones y recibirá una membership `STUDENT` en cada una.

`signup` recibe `name`, `rut` y `password`. `login` sólo recibe `rut` y
`password`, responde con una cookie `httpOnly`, `SameSite=Lax` y `Secure` en
producción, y nunca devuelve un token en JSON. Las sesiones se almacenan en
PostgreSQL como hashes; los endpoints protegidos validan la sesión y
autorización en el servidor.

`logout` requiere la cookie válida actual, revoca solamente esa sesión por su
hash, responde `204` y borra la cookie con los mismos atributos. No devuelve
tokens ni revoca otras sesiones activas del usuario.

Ambos endpoints públicos de autenticación limitan los intentos por dirección IP
mediante memoria local: admiten cinco intentos por ventana de 15 minutos y
responden `429` con un mensaje seguro al excederla. El límite es por proceso y
no se comparte entre réplicas; para producción distribuida se requiere un
limitador compartido. La aplicación no habilita `trust proxy`, por lo que detrás
de un proxy inverso los clientes pueden compartir la IP del proxy hasta que la
configuración de despliegue establezca una confianza de proxy correcta.

Los intentos de login de RUT inexistente o de cuentas sin `passwordHash` realizan
la misma verificación `scrypt` contra un hash ficticio válido y reciben la misma
respuesta genérica `401` que una contraseña incorrecta.

La migración APP-02 agrega `passwordHash` nullable para conservar los usuarios
de APP-01. Esas cuentas no pueden iniciar sesión hasta que exista un flujo
seguro de establecimiento de contraseña.

Este scaffold incluye facturas, integración opcional con Model API y lectura
acotada de recursos MLflow. La integración blockchain pertenece a tickets
posteriores.

### Perfil

`GET /profile` resuelve el perfil de la sesión cookie actual y devuelve nombre,
RUT, email, username y memberships con organización y rol. `PATCH /profile`
acepta exclusivamente `email` y `username`; nombre, RUT, password, roles y
memberships no son modificables desde este endpoint. La interfaz consulta el
perfil al iniciar, muestra la carga, una sesión expirada o anónima, y permite
actualizar los dos datos editables sin exponer ni persistir tokens.

### Organization groups

`Group` and `GroupMembership` are organization-scoped. A user can belong to
multiple groups in the same organization, while the database prevents duplicate
group-user pairs and enforces that every group member has an
`OrganizationMembership` in that group organization.

Authenticated users can call `GET /groups` to list only their groups and every
group member in deterministic organization, group, and member order. Group
management is scoped under `/organizations/:organizationId/groups`; only a
current `ADMIN` of that organization can create, update, or delete a group, or
add and remove members. The server validates the current session and resource
organization for every request, returning safe authorization responses for
absent sessions, non-members, and students. The ADMIN who creates a group is
added as its first member so the group remains visible and manageable.

Un administrador de plataforma puede administrar grupos de cualquier
organización, incluso sin una membership local. Esta capacidad se aplica en el
servidor y no depende de permisos entregados por el cliente.

El primer administrador de plataforma se establece fuera de HTTP mediante el
CLI local, con una confirmación explícita:

```bash
pnpm --filter @invoiceops/backend platform-administrator bootstrap <userId> --confirm-bootstrap
```

El CLI también admite la transferencia explícita con `transfer <userId>
--confirm-transfer`. No expone una ruta HTTP de bootstrap ni incluye secretos o
valores operacionales en sus argumentos.

Cookie-authenticated mutations use an Origin same-origin check in central
middleware. Requests carrying the session cookie must include an `Origin` that
exactly matches the request origin; cross-origin requests receive `403` before
the mutation handler. Vite and Nginx proxy `/groups` and `/organizations/` on
the same browser origin as the application.

### MLflow ownership contract

For INT-02, this application remains the academic source of truth. A Workspace
uses `Organization.slug`, an MLflow Basic Auth username uses the normalized
`User.rut`, and the RBAC role for a group is `group-<Group.id>`. `Group.id` is
the canonical immutable cross-repository identity; `Group.name` must never be
used as an MLflow identity, role, resource name, or permission key.

`GroupMembership` maps to assigning the group's RBAC role to the MLflow user.
Individual ML ownership uses `User.id` as `owner_id`; group ownership uses
`Group.id`. The complete contract and explicit out-of-scope provisioning are in
`../dev/tickets/INT-02_ownership_academico_mlflow.md`.

### Consulta de recursos MLflow (APP-09)

`GET /mlflow/resources?organizationId=<id>&ownerType=user|group&ownerId=<id>`
requiere la sesión de InvoiceOps. El backend comprueba la membership de la
organización y del grupo (o el propietario individual) antes de consultar al
proveedor. La pantalla de recursos reutiliza el selector de propietario: consulta
al abrir y cambiar de contexto, y cada 15 segundos mientras la pestaña está
visible. Un fallo conserva la última lectura exitosa del mismo contexto con
aviso de datos anteriores; sin lectura previa ofrece reintento.

Configura **en el entorno del backend** las cuatro variables siguientes (todas
juntas); en Compose se pasan al contenedor backend. No son variables `VITE_*`:

| Variable               | Uso                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MLFLOW_READ_URL`      | Origen REST de MLflow, sin ruta ni credenciales (por ejemplo, `http://127.0.0.1:5000` fuera de Compose; en Compose, sólo una dirección alcanzable desde el contenedor). |
| `MLFLOW_UI_URL`        | Origen al que puede navegar el navegador, independiente del origen REST; no debe apuntar a un hostname interno de Compose.                                              |
| `MLFLOW_READ_USERNAME` | Cuenta de servicio dedicada a lectura, no cuenta administradora.                                                                                                        |
| `MLFLOW_READ_PASSWORD` | Contraseña de esa cuenta; nunca se entrega al navegador.                                                                                                                |

La cuenta y los permisos mínimos admitidos por MLflow 3.16 se crean
**manualmente por el operador**: `USE` sobre cada Workspace objetivo y `READ`
sobre los Experiments y Registered Models concretos. MLflow no admite `READ`
como permiso de Workspace. `USE` también permite crear recursos nuevos en ese
Workspace; por tanto, la cuenta no es estrictamente de solo lectura para todas
las operaciones. No concedas `EDIT` ni `MANAGE` para habilitar esta consulta.
MLFLOW-07 conserva la responsabilidad de aprovisionamiento y reconciliación.
El cliente usa Basic Auth y el header
`X-MLFLOW-WORKSPACE` únicamente desde el backend. Un origen HTTP se acepta sólo
para loopback local; otros destinos requieren HTTPS. Orígenes con path, query,
fragmento o usuario embebido se rechazan al arrancar. En Compose, `localhost`
del backend es su propio contenedor, no el servicio MLflow: para una instancia
en otro contenedor o host, el operador debe proporcionar un origen HTTPS
alcanzable; no se habilita HTTP a otros hosts por conveniencia. Configuración
ausente o parcial deja sólo esta feature en `503 NOT_CONFIGURED`; el resto de
la aplicación permanece disponible. El backend no aprovisiona usuarios ni
concede permisos.

La lectura devuelve a lo sumo 25 runs y 25 versiones por actualización; si hay
continuación, `truncated: true` señala que la lista no es exhaustiva. Respuestas
MLflow inválidas devuelven `502 INVALID_RESPONSE`; errores HTTP, permisos
insuficientes y timeouts de 3 segundos en total (perfil, comprobaciones en
PostgreSQL y lectura REST) devuelven `503 UNAVAILABLE`. El límite corta la
espera HTTP y evita iniciar consultas adicionales al expirar; no cancela una
consulta PostgreSQL ya enviada, porque Prisma no ofrece esa cancelación en
este flujo. Incluso sin configurar el proveedor, un contexto ajeno responde
`404` antes de informar `503 NOT_CONFIGURED` para un contexto autorizado.
La respuesta no incluye credenciales ni URLs provistas por MLflow. Los enlaces
de Experiments, Runs y Model Registry se construyen desde `MLFLOW_UI_URL` y
las rutas de la UI de MLflow 3.16.1 con `?workspace=` en el fragmento. El
navegador debe poder autenticarse **por separado** en la UI de MLflow: la cookie
de InvoiceOps y la cuenta de lectura del backend no proporcionan SSO ni acceso
del navegador. Los permisos nativos de MLflow siguen vigentes al abrir el enlace.
En la validación histórica local con MLflow 3.16.0, una cuenta técnica con `USE` sólo en
el Workspace académico y `READ` exacto sobre sus recursos pudo leerlos por API,
pero `GET /` de la UI respondió `403` aun al añadir `?workspace=` a la URL base.
Por tanto, probar sólo la URL y el fragmento no acreditaba navegación. El pin
publicado `3.16.1` resolvió ese bloqueo en el stack local: una identidad no
administradora abrió en Chrome, desde el enlace renderizado por InvoiceOps,
la página real de una versión en el Workspace seleccionado. El documento inicial
devolvió `200`, mientras el acceso anónimo conservó `401`, una ruta desconocida
conservó `403` y fail-closed permaneció activo. La identidad tuvo `USE` sólo en
su Workspace y `READ` sobre recursos concretos; no se concedió acceso adicional
al Workspace predeterminado. Esta prueba host-local no demuestra SSO ni TLS o
despliegue Compose productivo: cada navegador aún debe autenticarse en MLflow.
Las rutas se contrastaron inicialmente con el código publicado de MLflow 3.16.0:
[`experiment-tracking/routes.ts`](https://github.com/mlflow/mlflow/blob/v3.16.0/mlflow/server/js/src/experiment-tracking/routes.ts),
[`model-registry/routes.ts`](https://github.com/mlflow/mlflow/blob/v3.16.0/mlflow/server/js/src/model-registry/routes.ts)
y [`WorkspaceUtils.ts`](https://github.com/mlflow/mlflow/blob/v3.16.0/mlflow/server/js/src/workspaces/utils/WorkspaceUtils.ts).

**Despliegue:** configura ambos orígenes para el entorno y una cuenta técnica
con `USE` en los Workspaces necesarios y `READ` sobre los recursos exactos;
confirma una lectura individual y otra grupal, recursos ausentes, permisos
insuficientes, enlaces y sesión de navegador con un operador autorizado. Esta
comprobación contra el proveedor operado no forma parte de las pruebas
unitarias. **Rollback:** retira las
cuatro variables y vuelve a desplegar el backend (la vista muestra un error
recuperable), o revierte la versión de aplicación; no hay migraciones ni datos
que deshacer. La rotación o revocación de la cuenta de lectura es operativa e
independiente de InvoiceOps.

### Policies de negocio versionadas

APP-07 conserva `invoice-rules-v1` sin cambios: procesa automáticamente sólo
facturas de hasta `500000` centavos con PO y three-way match. La decisión se
solicita con `POST /invoices/:invoiceId/decision` usando `{ "mode": "RULE_V1" }`;
el servidor calcula y persiste el resultado, por lo que el navegador no envía
`AUTO_PROCESS` ni `MANUAL_REVIEW` como una decisión autoritativa.

El modo `PROBABILITY_POLICY` requiere una versión explícita:

```json
{
  "mode": "PROBABILITY_POLICY",
  "policyVersion": "ml-policy-v1"
}
```

Las policies son owner-scoped por organización y contienen `version` y
`manualReviewThreshold` entre 0 y 1. Las individuales sólo las administra su
propietario; las grupales sólo un `ADMIN` de la organización. Se consultan,
crean y actualizan mediante `GET`, `POST` y `PATCH /business-policies` en el
mismo contexto `organizationId`, `ownerType` y `ownerId` de las facturas.

`PROBABILITY_POLICY` invoca el Model API sólo cuando `MODEL_API_URL` y
`MODEL_API_MODEL_ID` están configuradas. No existe una URL ni un modelo por
defecto. Si falta cualquiera de las dos variables, el proveedor se considera no
disponible; también se trata así un timeout, error HTTP o respuesta inválida. En
esos casos el cliente recibe la respuesta normal de la decisión y el servidor
persiste únicamente el fallback seguro `MANUAL_REVIEW`, con
`policyProbabilitySource: "MODEL_API_FALLBACK"` y metadata de modelo nula. No se
exponen detalles del proveedor en la respuesta HTTP.

`RULE_V1` permanece disponible e independiente de esta configuración. Con
inferencia disponible, `probability >= threshold` resulta en `MANUAL_REVIEW`.
Cada evento de auditoría conserva modo, versión, threshold, probabilidad, fuente,
recomendación y, cuando existe inferencia, modelo lógico, versión y run.

### Contrato App ↔ Model API (INT-01, v1)

La fuente de verdad del request y response HTTP es `PredictRequest` y
`PredictResponse` en Model API; el adaptador de la aplicación está en
`apps/backend/src/model-api-client.ts`. No existe un repositorio de contratos
independiente. La versión `v1` describe el contrato documentado; **no** añade
un segmento a la URL ni un campo al JSON. El ID lógico estable del catálogo
actual es `invoice-review`; configura ese valor en `MODEL_API_MODEL_ID` junto
con `MODEL_API_URL`. La aplicación codifica el ID como un único segmento de URL.

`POST /models/{model_id}/predict` recibe únicamente estas ocho features:

```json
{
  "invoice_amount_cents": 125000,
  "vendor_tenure_days": 365,
  "previous_incidents_12m": 1,
  "amount_vs_vendor_median": 1.25,
  "has_purchase_order": true,
  "three_way_match": true,
  "bank_account_recently_changed": false,
  "country_risk": "low"
}
```

Los tres primeros campos son enteros JSON; `amount_vs_vendor_median` es
numérico; los tres siguientes son booleanos JSON y `country_risk` es string.
Model API exige presencia, tipos estrictos y ausencia de campos adicionales;
rechaza con `422` el body inválido. `low`, `medium` y `high` son las categorías
entrenadas que envía la aplicación; el schema público actual del proveedor
admite cualquier string en `country_risk` y no restringe el dominio a esas tres.
No se transmiten identificadores de factura, credenciales ni datos de MLflow.

Respuesta exitosa de ejemplo:

```json
{
  "model_id": "invoice-review",
  "model_version": "7",
  "run_id": "run-123",
  "probability": 0.8
}
```

`model_id` identifica el modelo lógico solicitado; `model_version` y `run_id`
son identificadores string no vacíos de la instancia servida, no parámetros
MLflow del consumidor. `probability` es un número finito entre 0 y 1 (inclusive)
de la clase positiva `1`, correspondiente a revisión manual; no es una decisión.
La aplicación valida estos cuatro campos y exige que `model_id` coincida
exactamente con el ID configurado. Un ID ajeno, JSON inválido, respuesta HTTP no
exitosa, timeout de 2 segundos o probabilidad inválida disparan el fallback
auditable `MANUAL_REVIEW` / `MODEL_API_FALLBACK`, con probabilidad y metadata de
modelo nulas. La aplicación conserva el cálculo de threshold y recomendación.

El proveedor responde `404` para ID desconocido, `422` para request inválido y
`503` para modelo conocido no disponible o inferencia inválida/fallida; el
cliente no expone el detalle de esos errores. Para compatibilidad v1, conservar
los ocho campos de entrada, los cuatro campos de salida, sus tipos y la semántica
de probabilidad e ID; añadir campos de salida es tolerado por el cliente actual,
pero cambiar o eliminar campos existentes requiere un contrato versionado nuevo
y coordinación de ambos repositorios. No se exige una versión de modelo fija:
el champion puede cambiar manteniendo el mismo contrato HTTP.

La migración APP-08 es aditiva: agrega los campos de auditoría nullable y permite
la fuente `MODEL_API_FALLBACK`. Para revertir una aplicación, se revierte el
código y se conservan las columnas y eventos existentes; no se ejecuta un `DROP`
automático.

Para una demostración local repetible, con `DATABASE_URL` apuntando a la base
local `invoiceops` en `localhost` o al servicio Compose `db`, ejecuta:

```bash
NODE_ENV=development pnpm --filter @invoiceops/backend local-demonstration
```

El comando exige `NODE_ENV=development` y rechaza destinos remotos,
`invoiceops_test` y cualquier base distinta de `invoiceops`. Sólo crea o restablece los registros dedicados
`LOCAL_DEMONSTRATION`: la organización `APP-07 Local Demonstration`, el usuario
de prueba RUT `111111111` con contraseña `app-07-local-demonstration`, la policy
`ml-policy-v1` (threshold `0.8`) y dos facturas `PENDING`. En la UI, selecciona
esa organización y propietario individual. `DEMO-RULE-AUTO-POLICY-MANUAL`
resulta `AUTO_PROCESS` con Rule v1 y `MANUAL_REVIEW` con la policy; la segunda,
`DEMO-RULE-MANUAL-POLICY-AUTO`, invierte esos resultados. Ejecuta nuevamente el
comando entre intentos para restablecer sólo esas facturas demo a `PENDING`.

Antes de desplegar APP-07, aplica la migración explícita y luego la aplicación:

```bash
pnpm --filter @invoiceops/backend exec prisma migrate deploy
```

La migración es expansiva y no incluye backfill. Para rollback operativo,
revierte la aplicación a la versión previa y conserva las columnas y la tabla
`BusinessPolicy`; no elimines datos o esquema automáticamente.
