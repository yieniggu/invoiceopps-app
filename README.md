# InvoiceOps App

> **Ejecución local y operación:** sigue [`LOCAL_RUN.md`](LOCAL_RUN.md) (requiere
> el overlay de la recuperación P0; base de desarrollo `invoiceops`) y el
> [runbook de recuperación](../invoiceops-stack/RECOVERY_RUNBOOK.md). Este README
> describe la aplicación; sus recetas no habilitan operaciones remotas.

Aplicación académica InvoiceOps: backend Express con TypeScript, frontend React
con Vite y PostgreSQL, con un único esquema consolidado de recuperación P0
(migración `20261026000000_initial_recovery_p0`).

## Histórico (previo a la recuperación P0)

Los cierres anteriores (FULLAPP12 CR009–CR011, APP-12/S8, APP-13), las catorce
migraciones históricas y los flujos de evidencia/anclaje ya no forman parte de
esta base; sus instrucciones operativas fueron retiradas de este README.

## Interfaz en español

### Recorrido de trabajo

1. Inicia sesión con las credenciales entregadas por un administrador global.
   No existe registro público. Una cuenta provisionada recibe una contraseña
   temporal y debe cambiarla antes de acceder a la aplicación. La sesión usa una
   cookie; no copies tokens al navegador.
2. En **Mi perfil**, consulta identidad y membresías y guarda correo electrónico
   o nombre de usuario. Nombre, RUT y roles no se editan allí.
3. En **Organizaciones**, elige una membresía vigente; en **Mis grupos**, usa
   **Trabajar con…** para seleccionar un grupo al que perteneces. El resumen de
   organización/propietario permanece visible al navegar. Si el acceso se revoca,
   no se elige otro propietario automáticamente.
4. Desde **Panel principal**, abre el trabajo deseado. El panel muestra contexto
   y accesos, no totales financieros o métricas que la API no ofrece.
5. En **Facturas**, busca por ID/proveedor y carga más resultados explícitamente.
   **Ver…** abre el **detalle de factura**, sus hechos y su riesgo.
6. En **Políticas**, consulta versiones/umbrales del mismo propietario. El dueño
   individual puede crear/editar; las políticas grupales requieren ADMIN de esa
   organización.
7. **Administración** aparece solo para administradores de organización o
   plataforma. El primero gestiona grupos desde Mis grupos; solo plataforma
   crea organizaciones, provisiona usuarios con rol inicial y gestiona
   membresías. La contraseña temporal se muestra una sola vez y no se registra.
   Descubrir una organización administrable no concede acceso a su trabajo.

Las superficies vigentes son: acceso mediante login, perfil, organizaciones,
grupos, panel, facturas, detalle, políticas y administración. No son destinos
universales: el detalle se abre dentro de Facturas y Administración depende del rol.

### Estados, incertidumbre y límites

- Carga, vacío, validación y errores tienen mensajes en español y reintentos
  deliberados. Un 401 vigente retira la sesión; datos tardíos de otro contexto o
  sesión no deben publicarse. Los errores no muestran cuerpos crudos del proveedor.
- Navegar no cancela una escritura recibida por el servidor. Ante resultado
  desconocido no reenvíes a ciegas: en políticas consulta una versión/umbral
  coincidentes mediante una lectura posterior al error.
  En administración no existe lookup del destinatario: el resultado desconocido
  permanece bloqueado y requiere verificación autoritativa fuera de esa vista.
- Los registros de operaciones viven solo en memoria de sesión/navegación.
  Recargar pierde esos bloqueos; una nueva sesión no reconcilia efectos anteriores
  ni aporta idempotencia. Un cierre de sesión fallido conserva la incertidumbre.
- Facturas usa páginas de 50 por defecto, máximo API 100. Los detalles se
  consultan bajo acción explícita.

## Requisitos

- Node.js 24 o superior.
- pnpm 11 o superior.
- Docker Desktop con Docker Compose, para ejecutar el entorno completo.

## Verificación local equivalente a CI

La CI se ejecuta únicamente al abrir o actualizar un pull request contra `main`
y al hacer push a `main`. Usa Node 24, `pnpm@11.17.0` y el lockfile congelado.
Desde la raíz de `invoiceops-app`, reproduce sus gates sin iniciar servicios:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
docker compose config
docker compose build
```

`pnpm test` cubre las pruebas unitarias definidas por el workspace. La
verificación no ejecuta `pnpm test:integration`, migraciones, seed ni
`docker compose up`; tampoco publica imágenes, inicia sesión en un registry,
despliega, configura TLS o usa servicios externos reales. `docker compose build`
solo construye las imágenes existentes de backend y frontend.

## Configuración local

> Para levantar la app en el estado de recuperación P0 (pnpm o Docker, paso a
> paso), sigue [`LOCAL_RUN.md`](LOCAL_RUN.md).

### Local database (recovery P0)

El helper anterior de base administrada (`pnpm db:local:status` / `pnpm db:local:migrate`)
se retiró: administraba una base migrada con las migraciones históricas, que el
esquema consolidado no soporta. En su lugar, crea una base limpia
`invoiceops`, la única base local de desarrollo (solo loopback, con confirmación
explícita; nunca se imprimen credenciales). El reset recrea `invoiceops` y
destruye sus datos. `invoiceops_recovery_test` se usa solo en
`pnpm test:recovery:postgres`.

> Borra todos los datos de `invoiceops`; no lo ejecutes si quieres conservarlos.
> Precondición: `DATABASE_URL` debe apuntar a `127.0.0.1:$LOCAL_APP_DB_PORT/invoiceops`
> (carga `.env` como en `LOCAL_RUN.md`). Compruébalo sin imprimir credenciales con
> `printf '%s\n' "${DATABASE_URL#*@}"`, que muestra solo `host:puerto/base`; si no
> coincide, no continúes.

```bash
printf '%s\n' "${DATABASE_URL#*@}"   # esperado: 127.0.0.1:<LOCAL_APP_DB_PORT>/invoiceops?schema=public
pnpm recovery:local:reset -- --confirm-reset=invoiceops
```

Consulta [`LOCAL_RUN.md`](LOCAL_RUN.md) para el procedimiento local completo y los
comandos `pnpm test:recovery:unit` / `pnpm test:recovery:postgres`.

Crea `.env`, levanta PostgreSQL y el backend/frontend siguiendo
[`LOCAL_RUN.md`](LOCAL_RUN.md). No se duplican aquí los pasos ni la tabla de
variables. Las migraciones son explícitas: el backend, Docker Compose y el
arranque no ejecutan cambios de esquema automáticamente.

### Límite de intentos de login

`POST /api/v1/auth/login` limita los intentos **fallidos** en memoria (se
reinicia con el backend) con dos claves: la IP del cliente (5 por ventana fija
de 15 minutos) y el RUT normalizado (5 intentos y luego un bloqueo progresivo de
1 minuto que se duplica hasta la ventana; un login correcto lo reinicia). Basta
que una de las dos claves esté bloqueada para recibir `429`. Cada intento se
reserva antes de verificar la contraseña. Para desarrollo se puede ajustar con
`AUTH_RATE_LIMIT_DISABLED`, `AUTH_RATE_LIMIT_MAX_ATTEMPTS` y
`AUTH_RATE_LIMIT_WINDOW_MS`, por ejemplo `AUTH_RATE_LIMIT_DISABLED=true pnpm dev`.
Desactivarlo está prohibido con `NODE_ENV=production`. `AUTH_RATE_LIMIT_DISABLED`
acepta `true`, `false` o vacío (sin distinguir mayúsculas ni espacios); cualquier
otro valor detiene el arranque con un error. `AUTH_TRUST_PROXY_HOPS` (entero no
negativo; vacío o sin definir = no confiar en ningún proxy; un valor inválido
detiene el arranque) indica cuántos proxies inversos confiables preceden al
backend para que `request.ip` sea el cliente real y no el proxy.
Las variables se aplican al proceso del backend (`pnpm dev`, ruta A); el overlay
de Docker no las reenvía; el `docker-compose.yml` base solo fija
`AUTH_TRUST_PROXY_HOPS=1` (nginx es el único proxy) y publica el backend solo en
loopback. Detalle en [`LOCAL_RUN.md`](LOCAL_RUN.md).

## URLs y checks

Con `pnpm dev`:

- Frontend: `http://127.0.0.1:5380`
- Backend: `http://127.0.0.1:4380`
- Liveness: `http://127.0.0.1:4380/health/live`
- Readiness de PostgreSQL: `http://127.0.0.1:4380/health/ready`

Con Docker + overlay local:

- Frontend: `http://127.0.0.1:5174`
- Backend: `http://127.0.0.1:5300` (mismas rutas `/health/live` y `/health/ready`)

El servidor de desarrollo de Vite escucha solo en `127.0.0.1`.

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

Desde la raíz de `invoiceops-app`, con Docker local disponible y la imagen
`postgres:17-alpine` ya descargada, ejecuta el gate sin configurar
`DATABASE_URL`, `TEST_DATABASE_URL` ni `APP10_TEST_NAMESPACE`:

```bash
pnpm test:integration
```

The runner creates a new isolated container with a unique role and password, a
loopback-only ephemeral port, and bounded memory and temporary storage. It does
not use `.env`, persistent volumes, or the Compose `db-test` service. It applies
the consolidated migration (`20261026000000_initial_recovery_p0`, which must be
the first migration), verifies the `_prisma_migrations` ledger name, checksum and
status against the files on disk, and runs the 26 organization-persistence
PostgreSQL cases.

## Alcance actual

### Autenticación

Todas las rutas funcionales viven bajo `/api/v1` (`/health/*` y
`/openapi.json` quedan en la raíz). El backend expone
`POST /api/v1/auth/login`, `POST /api/v1/auth/change-password` y
`POST /api/v1/auth/logout`. Los errores usan el sobre
`{"error":{"code","message","fields?"}}`. `GET /openapi.json` publica el
documento OpenAPI 3.1 generado desde los esquemas Zod. No existe registro público ni configuración `AUTH_MODE` o
allowlist. El administrador global provisiona identidades y membresías mediante
la administración autenticada; sin habilitar registro público.

`login` sólo recibe `rut` y `password`, responde con una cookie `httpOnly`, `SameSite=Lax` y `Secure` en
producción, y nunca devuelve un token en JSON. Las sesiones se almacenan en
PostgreSQL como hashes; los endpoints protegidos validan la sesión y
autorización en el servidor.

`logout` requiere la cookie válida actual, revoca solamente esa sesión por su
hash, responde `204` y borra la cookie con los mismos atributos. No devuelve
tokens ni revoca otras sesiones activas del usuario.

`change-password` exige una contraseña nueva distinta de la actual (`400
PASSWORD_REUSE`). En una sola transacción actualiza el hash, quita el cambio
obligatorio, elimina todas las sesiones del usuario, crea una sesión nueva (cookie
`Set-Cookie` rotada), revoca sus API tokens y registra auditoría. Login y cambio de
contraseña se serializan por usuario con un bloqueo de fila (`SELECT … FOR
UPDATE`), de modo que un login iniciado antes del cambio no deja sesión con la
credencial anterior. Con `mustChangePassword` el perfil, el cambio de contraseña y
el logout (y el `PATCH /api/v1/profile` heredado) son las únicas rutas
permitidas; el resto responde `403 ONBOARDING_REQUIRED`. La sesión de un usuario
con contraseña temporal caduca como máximo cuando caduca la temporal. Una petición
con `Authorization` y cookie de sesión responde `400 AMBIGUOUS_AUTH`; `Authorization`
sola responde `401` (los Bearer llegan con RP0-16). El perfil incluye `contexts`:
grupos de organizaciones habilitadas con ambas membresías y sus capacidades.

Solo `POST /api/v1/auth/login` limita los intentos mediante memoria local
(`logout` y `change-password` no tienen límite). Política: cuenta únicamente
credenciales **fallidas**, con dos claves (IP del cliente y RUT normalizado; ambas
deben permitir). La clave de IP usa cinco fallos por ventana fija de 15 minutos;
la del RUT bloquea de forma progresiva (al quinto fallo 1 minuto, luego 2, 4, 8…
hasta la ventana) y se reinicia con un login correcto, de modo que un tercero
no puede dejar fuera a una cuenta durante 15 minutos con una sola ráfaga. El
intento se reserva de forma síncrona antes de verificar la contraseña (y se
devuelve si el login es correcto o falla por un error del servidor), por lo que
las peticiones paralelas no superan el máximo. Al excederlo responde `429` con un
mensaje seguro. El límite es por proceso y no se comparte entre réplicas; para
producción distribuida se requiere un limitador compartido. La memoria está
acotada (10 000 claves): las claves inactivas se descartan primero y nunca una
clave bloqueada salvo que todas lo estén.

Por defecto la aplicación no confía en ningún proxy (`request.ip` es la dirección
del socket, `X-Forwarded-For` se ignora). Detrás de un proxy inverso define
`AUTH_TRUST_PROXY_HOPS` con el número exacto de proxies que controlas (nginx del
frontend = `1`; el `docker-compose.yml` base ya lo fija); un valor mayor al real
permite falsificar la IP y uno menor deja a todos los clientes con la IP del
proxy. No lo definas si el backend es accesible sin pasar por el proxy.
**Riesgo residual (Docker local):** el backend sigue publicado en
`127.0.0.1:<puerto>` porque `/health/*` solo existe allí; un proceso local que
llame directamente a ese puerto puede falsificar `X-Forwarded-For` y esquivar la
clave de IP (la clave por RUT, con bloqueo progresivo, sigue aplicando). Acepta
este riesgo solo en una máquina de desarrollo de confianza y no publiques ese
puerto en otras interfaces.
Los eventos de autenticación se registran como una línea JSON
(`auth.login_failed`, `auth.rate_limited`, `auth.password_changed`,
`http.unhandled_error`) con campos acotados: nunca RUT, contraseñas, cookies,
tokens ni mensajes de error.

Los intentos de login de RUT inexistente o de cuentas sin `passwordHash` realizan
la misma verificación `scrypt` contra un hash ficticio válido y reciben la misma
respuesta genérica `401` que una contraseña incorrecta. Un RUT con formato
inválido se rechaza sin ejecutar `scrypt`, por lo que difiere el tiempo de
respuesta (RV-085, riesgo aceptado; revisar si cambia el modelo de amenaza).

La aplicación incluye consulta de facturas (listado y detalle) y policies de
negocio versionadas.

### Perfil

`GET /api/v1/auth/profile` resuelve el perfil de la sesión cookie actual y devuelve nombre,
RUT, email, username, `mustChangePassword` y memberships con organización y rol.
`PATCH /api/v1/profile`
acepta exclusivamente `email` y `username`; nombre, RUT, password, roles y
memberships no son modificables desde este endpoint. La interfaz consulta el
perfil al iniciar, muestra la carga, una sesión expirada o anónima, y permite
actualizar los dos datos editables sin exponer ni persistir tokens.

Un `PATCH /api/v1/profile` inválido responde `400 VALIDATION_ERROR` con el mapa
`fields` (campo → mensaje) de forma intencional: es el único endpoint heredado que
lo incluye; los demás endpoints heredados responden solo `code` y `message` hasta
que su ticket los documente.

### Organization groups

`Group` and `GroupMembership` are organization-scoped. A user can belong to
multiple groups in the same organization, while the database prevents duplicate
group-user pairs and enforces that every group member has an
`OrganizationMembership` in that group organization.

Authenticated users can call `GET /api/v1/groups` to list only their groups and every
group member in deterministic organization, group, and member order. Group
management is scoped under `/api/v1/organizations/:organizationId/groups`; only a
current `ADMIN` of that organization can create, update, or delete a group, or
add and remove members. The server validates the current session and resource
organization for every request, returning safe authorization responses for
absent sessions, non-members, and users with the USER role. The ADMIN who creates a group is
added as its first member so the group remains visible and manageable.

Un administrador de plataforma puede administrar grupos de cualquier
organización, incluso sin una membership local. Esta capacidad se aplica en el
servidor y no depende de permisos entregados por el cliente.

El primer administrador de plataforma se crea fuera de HTTP con
`pnpm recovery:bootstrap`: pide nombre, RUT y contraseña temporal (dos veces, sin
eco, solo por terminal interactiva) y, en una transacción, crea el usuario con
cambio obligatorio y la designación única. Repetirlo con el mismo RUT no cambia
nada; con otro RUT se rechaza. `--existing-user` designa a un usuario que ya
tiene credencial. Solo corre contra una `DATABASE_URL` local.

El CLI de transferencia sigue disponible, con una confirmación explícita:

```bash
pnpm --filter @invoiceops/backend platform-administrator transfer "<userId>" --confirm-transfer
```

No expone una ruta HTTP de bootstrap ni incluye secretos o valores
operacionales en sus argumentos.

Cookie-authenticated mutations use an Origin same-origin check in central
middleware. Requests carrying the session cookie must include an `Origin` that
exactly matches the request origin; cross-origin requests receive `403` before
the mutation handler. Vite and Nginx proxy `/api/` and `/openapi.json` on
the same browser origin as the application.

### Policies de negocio versionadas

Las policies son owner-scoped por organización y contienen `version` y
`manualReviewThreshold` entre 0 y 1. Las individuales sólo las administra su
propietario; las grupales sólo un `ADMIN` de la organización. Se consultan,
crean y actualizan mediante `GET`, `POST` y `PATCH /api/v1/business-policies` en el
mismo contexto `organizationId`, `ownerType` y `ownerId` de las facturas.
