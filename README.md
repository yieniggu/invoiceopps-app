# InvoiceOps App

> **Ejecución local y operación:** sigue [`LOCAL_RUN.md`](LOCAL_RUN.md) (requiere
> el overlay de la recuperación P0; base de desarrollo `invoiceops`) y el
> [runbook de recuperación](../invoiceops-stack/RECOVERY_RUNBOOK.md). Este README
> describe la aplicación; sus recetas no habilitan operaciones remotas.
>
> **Despliegue en producción (un host Docker detrás de un túnel):** [`DEPLOY.md`](DEPLOY.md).

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
3. En **Organizaciones** (`/organizations`), abre una organización vigente; en
   **Grupos** (`/groups`), abre un grupo al que perteneces con «Ver grupo». La
   organización o el grupo cuyas facturas ves se eligen solo con el selector
   «Ver facturas de» de **Facturas**. Si el acceso se revoca, la opción
   desaparece del selector y la selección vuelve a la predeterminada.
4. Desde **Panel principal** (`/dashboard`), abre el trabajo deseado. El panel
   muestra tu organización y accesos, no totales financieros o métricas que la API no
   ofrece.
5. **Facturas** (`/invoices`) es la bandeja de facturas. El menú la ofrece a
   quien tiene algún permiso de facturas (no se deduce del rol ADMIN). El
   selector «Ver facturas de» ofrece «Toda la organización» y «Sin grupo
   asignado» (con lectura de organización) y cada grupo con lectura efectiva; con
   varias organizaciones, cada opción nombra la suya. Sin ninguna opción de
   lectura se explica el motivo y no se consulta la API. La organización o el
   grupo, el estado, las fechas de emisión, el texto (número o proveedor) y la
   página viajan en la URL (`organizationId`, `groupId` o `ungrouped=true`,
   `businessStatus`, `issuedFrom`, `issuedTo`, `q`, `page`); cambiar la selección o un filtro vuelve
   a la página 1. «Actualizar» recarga la lista. Cada fila enlaza al **detalle**
   (`/invoices/:invoiceId?organizationId=…&groupId=…`), que muestra el estado de
   la factura y el estado de procesamiento por separado, y ofrece «Eliminar
   factura» a quien tiene el permiso de eliminación aplicable
   (`deleteOwnInvoices` o `deleteOthersInvoices`). Quien tiene el permiso
   `createInvoices` ve «Nueva factura» en la bandeja y crea una en la
   organización o en un grupo.
6. **Políticas** (`/policies`) está deshabilitada por ahora: el ítem del menú se
   muestra con la insignia «Próximamente» y la ruta responde «No disponible por
   ahora.». El código de la pantalla de políticas se conserva sin enrutar.
7. La gestión vive en las pantallas de organizaciones y grupos; el administrador
   de plataforma suma además **Admin** (`/admin`), el directorio de personas de
   la plataforma. En `/organizations/new` («Crear organización», solo el
   administrador de plataforma) se indica de forma explícita el RUT del primer
   ADMIN de la organización (la plataforma no recibe acceso a facturas ni a
   grupos). Cada ADMIN de organización gestiona su organización en pantallas
   separadas; las listas largas (organizaciones, miembros, directorio) se
   paginan de a 20 con «Anterior»/«Siguiente» y la página viaja en la URL:

   | Ruta                                                 | Pantalla                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
   | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `/organizations`                                     | Organizaciones de la persona; para el administrador de plataforma, el directorio de **todas** (búsqueda por nombre y página en la URL; «Ver detalle» abre cualquiera, sea o no miembro)                                                                                                                                                                                                                                                                            |
   | `/organizations/:organizationId`                     | Resumen: nombre, identificador, descripción, cantidad de miembros y de grupos; enlaces «Miembros» y «Grupos»; para ADMIN o plataforma, «Agregar miembro» y «Editar organización»                                                                                                                                                                                                                                                                                   |
   | `/organizations/:organizationId/edit`                | «Editar organización»: nombre y descripción (ADMIN o plataforma); el identificador (slug) es inmutable                                                                                                                                                                                                                                                                                                                                                             |
   | `/organizations/:organizationId/members`             | ADMIN o plataforma: tabla de miembros paginada (nombre, RUT, rol, estado habilitado/desactivado, actividad reciente, grupos, permisos «n de 4»); selección por fila, «Seleccionar todos en esta página» y «Editar permisos en bloque» (la selección se vacía al cambiar de página; una página fuera de rango lleva a la última). Miembro común: lista reducida (nombre, correo, actividad reciente), sin acciones de administración, con enlace a `/users/:userId` |
   | `/organizations/:organizationId/members/new`         | Pestañas «Agregar persona existente» (RUT, rol, permisos) y «Crear persona nueva» (asistente de cuatro pasos de una organización)                                                                                                                                                                                                                                                                                                                                  |
   | `/organizations/:organizationId/members/:userId`     | Miembro: cambio de rol, permisos de organización, grupos de la organización (permisos, agregar y quitar) y quitar de la organización; se resuelve por id (`userIds`), también a partir del miembro 101                                                                                                                                                                                                                                                             |
   | `/organizations/:organizationId/members/permissions` | Permisos en bloque de `?userIds=a,b` (sobrevive a recargar); «Aplicar a N miembros»; consulta solo los ids elegidos                                                                                                                                                                                                                                                                                                                                                |
   | `/organizations/:organizationId/groups`              | Tarjetas de grupos con «Ver grupo»                                                                                                                                                                                                                                                                                                                                                                                                                                 |
   | `/organizations/:organizationId/groups/new`          | Solo nombre y descripción; al crear lleva a agregar miembros                                                                                                                                                                                                                                                                                                                                                                                                       |
   | `/organizations/:organizationId/groups/:groupId`     | Resumen del grupo: nombre, descripción, cantidad total de miembros y enlace «Miembros»                                                                                                                                                                                                                                                                                                                                                                             |
   | `.../groups/:groupId/members`                        | Tabla paginada (`?page=`, 20 por página) de miembros del grupo con selección por página y «Editar permisos en bloque»                                                                                                                                                                                                                                                                                                                                              |
   | `.../groups/:groupId/members/new`                    | Elegir varios miembros de la organización: lista de 20 por página con búsqueda por nombre/RUT en el servidor (`?search=&page=` en la URL); quiénes ya están en el grupo se consulta por `userIds` solo para la página visible (≤ 20 ids); «Seleccionar todos en esta página»; la selección se conserva al cambiar de página o de búsqueda (es un flujo de agregar) y el contador dice «N personas seleccionadas»; permisos por persona o «Aplicar los mismos…»     |
   | `.../groups/:groupId/members/:userId`                | Permisos de la persona en el grupo y quitar del grupo; se resuelve por id (`userIds`), también más allá de la primera página                                                                                                                                                                                                                                                                                                                                       |
   | `.../groups/:groupId/members/permissions`            | Permisos en bloque del grupo (`?userIds=`); consulta solo los ids elegidos                                                                                                                                                                                                                                                                                                                                                                                         |
   | `/users/:userId`                                     | Perfil básico de alguien con quien compartes organización (nombre, correo, actividad reciente, organizaciones compartidas; sin RUT); si no, «Página no encontrada». El administrador de plataforma ve a cualquiera, con todas sus organizaciones                                                                                                                                                                                                                   |
   | `/admin`                                             | Solo plataforma: directorio de personas (búsqueda por nombre o fragmento de RUT con o sin puntos, filtro de estado, página en la URL); ya no redirige a `/admin/users/new`                                                                                                                                                                                                                                                                                         |
   | `/admin/users/:userId`                               | Solo plataforma: datos, estado y actividad, «Editar» (nombre y RUT), «Restablecer contraseña» (clave temporal que se muestra una sola vez), «Desactivar»/«Reactivar» y membresías                                                                                                                                                                                                                                                                                  |

   Los cuatro permisos de facturas (leer, crear, eliminar propias, eliminar de
   otros; todos desactivados por defecto) se muestran como botones de alternancia
   (+ activa, − desactiva; con «Marcar todos» y «Desmarcar todos»). El estado de
   cada botón lo transmiten `aria-pressed` y el ícono/borde; los botones no
   llevan texto de estado como «Activado» o «Desactivado». Se asignan por
   persona, en su membresía de organización y en la de grupo (efectivo en grupo =
   organización o grupo), con «Guardar» en las pantallas de la persona.
   Un administrador (de organización o de plataforma) puede asignarse permisos a
   sí mismo: queda registrado de forma durable en la auditoría
   (`actorIsTarget`) y ningún rol da acceso implícito a facturas. Cambiar tu
   propio rol pide confirmación y, tras quitarte de una organización, la app te
   lleva a **Organizaciones** con un aviso. Agregar
   varias personas a un grupo es atómico (todas o ninguna; hasta 200 por
   operación, igual que los permisos en bloque). En pantallas angostas (menos de
   40 rem) las tablas de personas pasan a filas apiladas con la etiqueta de cada
   columna, sin desplazamiento horizontal.

   > **Aviso (RP0-11):** la lectura de facturas (`GET /api/v1/invoices` y
   > `GET /api/v1/invoices/{invoiceId}`, con `organizationId` y `groupId`
   > opcional) ya consulta los permisos efectivos `readInvoices`.
   >
   > **Eliminación (RP0-12):** `DELETE /api/v1/invoices/{invoiceId}?organizationId=…[&groupId=…]`
   > elimina lógicamente la factura (`204` sin cuerpo; repetirlo también responde
   > `204` sin duplicar el evento). Exige `deleteOwnInvoices` si el actor es el
   > creador y `deleteOthersInvoices` en caso contrario, resueltos con los
   > permisos de organización (alcance organización) u organización O grupo
   > (factura de grupo); no exige `readInvoices` ni `createInvoices`. Una factura
   > fuera del alcance del actor responde `404` y dentro del alcance sin permiso
   > `403`. La factura, su creador y la idempotencia se conservan, el `businessId`
   > sigue reservado y el reintento del `POST` con la misma `Idempotency-Key`
   > responde `410 INVOICE_DELETED`. Cada eliminación registra un evento en la
   > tabla `InvoiceEvent`, creada por la migración `20261029000000_invoice_events`
   > (aditiva e idempotente: la base local la aplica con el `migrate` normal). Si
   > tu base local ya aplicó una edición anterior de esta migración aún no
   > publicada (checksum distinto), `migrate` la reportará como modificada:
   > recrea la base una sola vez con
   > `pnpm recovery:local:reset -- --confirm-reset=invoiceops` y vuelve a ejecutar
   > `pnpm recovery:bootstrap`. La misma migración añade los índices de lectura de `Invoice` (índice
   > parcial por organización `WHERE "deletedAt" IS NULL` y trigram `pg_trgm` sobre
   > `businessId` y `supplierName`) y un trigger que impide cambiar la
   > organización, el grupo o el `scopeKey` de una factura: el alcance de una
   > factura es inmutable.
   >
   > **Lectura y grupos (opción A):** `GET /api/v1/invoices` y el detalle devuelven
   > `InvoiceView`, la factura más `groupName` (`null` en alcance organización).
   > Para poder nombrar y elegir cualquier grupo, quien tiene `readInvoices` a
   > nivel de organización ve todos los grupos en
   > `GET /organizations/{organizationId}/groups` y los cuenta en
   > `summary.groupCount` de `GET /organizations/{organizationId}`; sin esa
   > lectura sólo ve sus propios grupos. Una lista y su conteo usan la misma regla.
   > Un `invoiceId` que no es un uuid responde el mismo `404` genérico que una
   > factura inexistente.

   El administrador de
   plataforma crea usuarios con varias organizaciones y grupos en **Admin →
   Crear usuario** (`/admin/users/new`; `?organizationId=` preselecciona, también si la organización no está en la primera página), con
   el mismo asistente de cuatro pasos (Datos → Organizaciones → Grupos →
   Resumen; organizaciones y grupos son tarjetas plegables con un resumen de una
   línea; un usuario puede tener hasta 200 grupos en total entre todas sus
   organizaciones: al llegar al tope el asistente deja de ofrecer grupos; con más de 100 organizaciones cada tarjeta añade un buscador por nombre, `GET /organizations?search=`, para elegir cualquiera). En el
   paso Datos se elige la **contraseña temporal**: «Generar
   automáticamente» (por defecto; el servidor la genera, se muestra una sola vez,
   con `Cache-Control: no-store`, y no se registra) o «Definir contraseña
   temporal» (8 a 256 caracteres, repetida; viaja en el cuerpo de la solicitud,
   la respuesta no la devuelve y la interfaz no la muestra ni la guarda en
   cachés). En ambos casos la persona debe cambiarla al iniciar sesión. La
   contraseña generada se muestra en un cuadro que solo se cierra con «Ya copié
   la contraseña» (Escape y el fondo no lo descartan); «Copiar» la envía al
   portapapeles o, si no hay permiso, la deja seleccionada.
   Cuando el administrador de plataforma crea una organización y nombra a otra
   persona como primer ADMIN, la organización aparece en su directorio aunque no
   sea miembro y puede abrirla para administrarla (nunca accede a sus facturas).
   Una persona desactivada no puede iniciar sesión (el login muestra el mismo
   mensaje que una contraseña errónea) hasta que la plataforma la reactive.
   Las rutas antiguas en español (`/panel`, `/facturas`, `/organizaciones`,
   `/grupos`, etc.) ya no existen y no redirigen: cualquier URL desconocida
   muestra «Página no encontrada». Descubrir una organización administrable no
   concede acceso a su trabajo. Las rutas `/platform/*` del frontend y
   `/api/v1/platform/users` se retiraron (RP0-05 a RP0-08): la administración
   vive bajo `/api/v1/organizations`.

Las superficies vigentes son: acceso mediante login, perfil, organizaciones,
grupos, panel, facturas y detalle (políticas está deshabilitada). No son destinos universales: el
detalle se abre dentro de Facturas y la gestión de personas y grupos depende del
rol (ADMIN de la organización).

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
- Facturas usa páginas de 20 (máximo API 100), con la página en la URL. Un 403
  retira los datos y refresca el perfil; un 404 del detalle muestra «Factura no
  encontrada».

### Tema claro y oscuro

- Por defecto la interfaz sigue la preferencia del sistema y reacciona si esta
  cambia. El control **Tema** (Claro / Oscuro / Sistema) guarda la elección en
  `localStorage` bajo `invoiceops.theme`; «Sistema» borra la clave.
- La preferencia es del navegador: no depende de la sesión ni del usuario. Si
  el almacenamiento está bloqueado, la elección solo dura la página.
- `apps/frontend/index.html` incluye un script en línea que fija `data-theme`
  antes del primer pintado. Si algún día se añade una CSP, ese script necesitará
  un hash o nonce (o moverse a un archivo propio).

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
`pnpm test:recovery:postgres` (y los clientes) e `invoiceops_recovery_e2e` solo en las
pruebas E2E del navegador.

> Borra todos los datos de `invoiceops`; no lo ejecutes si quieres conservarlos.
> Precondición: `DATABASE_URL` debe apuntar a `127.0.0.1:$LOCAL_APP_DB_PORT/invoiceops`
> (carga `.env` como en `LOCAL_RUN.md`). Compruébalo sin imprimir credenciales con
> `printf '%s\n' "${DATABASE_URL#*@}"`, que muestra solo `host:puerto/base`; si no
> coincide, no continúes.

```bash
printf '%s\n' "${DATABASE_URL#*@}"   # esperado: 127.0.0.1:<LOCAL_APP_DB_PORT>/invoiceops?schema=public
pnpm recovery:local:reset -- --confirm-reset=invoiceops
```

> El esquema de desactivación de usuarios (`User.disabledAt`, `User.lastActiveAt`,
> tipos de auditoría `USER_DEACTIVATED`/`USER_REACTIVATED`/`USER_UPDATED`/`PASSWORD_RESET`/`ORGANIZATION_UPDATED`)
> y los índices trigram (`pg_trgm`) de las búsquedas llegan en la migración
> idempotente `20261028000000_user_status_activity`: una base existente la recibe
> con `pnpm --filter @invoiceops/backend exec prisma migrate deploy` (sin reset).
> Solo si tu base se creó con la edición anterior de la migración inicial
> (checksum distinto) `migrate dev` se queja de esa migración: recrea la base una
> vez con `pnpm recovery:local:reset`.

Consulta [`LOCAL_RUN.md`](LOCAL_RUN.md) para el procedimiento local completo y los
comandos `pnpm test:recovery:unit` / `pnpm test:recovery:postgres`. Las pruebas de la
interfaz de recuperación (onboarding, organizaciones, grupos, usuarios y membresías)
se ejecutan con `pnpm test:recovery:ui`.
Las pruebas E2E del navegador (Playwright, pila real contra la base dedicada `invoiceops_recovery_e2e`) se ejecutan con `pnpm test:e2e`; ver «Pruebas E2E del navegador» en [`LOCAL_RUN.md`](LOCAL_RUN.md). La certificación P0 es `pnpm test:recovery:e2e` (recorrido RP0-20); la matriz G01–G20 está en [`docs/recovery-acceptance.md`](docs/recovery-acceptance.md).

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
backend para que `request.ip` sea el cliente real y no el proxy. `PUBLIC_ORIGIN`
(origen del navegador, p. ej. `https://invoiceops.aglai.dev`, sin ruta; vacío = se
usa `Host` y `X-Forwarded-Proto`; un valor inválido detiene el arranque) fija el
`Origin` exacto que exigen las escrituras con cookie cuando TLS termina antes del
backend.
Las variables se aplican al proceso del backend (`pnpm dev`, ruta A); el overlay
de Docker no las reenvía; el `docker-compose.yml` base solo fija
`AUTH_TRUST_PROXY_HOPS=1` (nginx es el único proxy) y publica solo en loopback el
backend, el frontend y la base de pruebas `db-test` (`127.0.0.1:`; esta última
tiene una contraseña conocida y las suites la vacían). Detalle en
[`LOCAL_RUN.md`](LOCAL_RUN.md).

## URLs y checks

Con `pnpm dev`:

- Frontend: `http://127.0.0.1:5380`
- Backend: `http://127.0.0.1:4380`
- Liveness: `http://127.0.0.1:4380/health/live`
- Readiness de PostgreSQL: `http://127.0.0.1:4380/health/ready`

Con Docker + overlay local:

- Frontend: `http://127.0.0.1:5174`
- Backend: `http://127.0.0.1:5300` (mismas rutas `/health/live` y `/health/ready`)

El servidor de desarrollo de Vite escucha solo en `127.0.0.1`. El backend
también: escucha en `HOST` (por defecto `127.0.0.1`). En el contenedor la imagen
y `docker-compose.yml` fijan `HOST=0.0.0.0` para que el puerto publicado llegue
al proceso; el puerto sigue publicado solo en loopback del anfitrión. No
definas `HOST=0.0.0.0` fuera de un contenedor.

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

El runner crea un contenedor aislado nuevo con un rol y una contraseña únicos,
un puerto efímero solo de loopback y memoria y almacenamiento temporal acotados.
No usa `.env`, volúmenes persistentes ni el servicio `db-test` de Compose. Aplica
las migraciones (`20261026000000_initial_recovery_p0` debe ser la primera, luego
`20261028000000_user_status_activity` y después `20261029000000_invoice_events`),
verifica el nombre, el checksum y el estado del registro `_prisma_migrations`
contra los archivos en disco y ejecuta los 24 casos de persistencia de
organizaciones contra PostgreSQL.

## Alcance actual

### Tokens de API operacionales (RP0-16)

`POST /api/v1/api-tokens` (solo sesión con cookie y la comprobación de `Origin`
habitual) emite un token `iop_…` para una organización o un grupo:
`{name, organizationId, groupId?, scopes[], expiresAt}` con `scopes` entre
`invoices:read`, `invoices:create`, `invoices:delete-own`,
`invoices:delete-others`, `mlflow:read` y `mlflow:write`, y `expiresAt` futuro y como máximo a 30 días. La
respuesta `201` (`Cache-Control: no-store`) devuelve `{token, secret}`: el
secreto se muestra una sola vez y la base guarda solo su hash SHA-256. Los
scopes no pueden superar los permisos vigentes de la persona en ese alcance
(si los superan, `403 FORBIDDEN`). Regla de los scopes `mlflow:*` (MLOPS-01):
cualquier miembro activo del contexto puede emitirlos (usuario no desactivado y
con onboarding completo, organización habilitada, membresía de la organización
y, para un token de grupo, membresía del grupo), sin importar sus permisos de
facturas ni su rol. `GET /api/v1/api-tokens?organizationId=…[&groupId=…]`
lista los tokens propios (también los revocados) y
`DELETE /api/v1/api-tokens/{tokenId}` revoca uno propio (`204`, repetible).

Límites de emisión: cada persona puede intentar emitir como máximo **20 tokens
cada 15 minutos** (cada intento cuenta, también los inválidos; el exceso
responde `429 RATE_LIMITED`, el mismo sobre que el inicio de sesión, y se
desactiva junto con él con `AUTH_RATE_LIMIT_DISABLED` solo en local) y puede
tener como máximo **50 tokens activos** (ni revocados ni vencidos) por persona
y organización; el intento 51 responde `409 TOKEN_LIMIT` hasta que revoque o
venza alguno.

Un token se usa con `Authorization: Bearer iop_…` **solo** en las cuatro
operaciones de facturas (`POST`/`GET /api/v1/invoices`, `GET`/`DELETE
/api/v1/invoices/{invoiceId}`), sin cookie ni `Origin`; en cualquier otra ruta
responde `401`, y Bearer más cookie responde `400 AMBIGUOUS_AUTH`. El token
nunca amplía permisos: se aplica el AND de los permisos vigentes de su dueño y
sus scopes. Un token de grupo opera solo en ese grupo y uno de organización en
cualquier alcance de su organización; lo que el dueño puede pero el token no,
responde `403 INSUFFICIENT_SCOPE`. Un token desconocido, vencido o revocado, o
un dueño desactivado, responde `401` con `WWW-Authenticate: Bearer`; con
contraseña temporal pendiente, `403 ONBOARDING_REQUIRED`. Cambiar la
contraseña, desactivar al usuario, restablecer su contraseña o cambiar su RUT
revoca sus tokens.

#### Introspección privada para el gateway de MLflow (MLOPS-01)

`POST /internal/api-tokens/introspect` está fuera de `/api/v1`, no figura en
OpenAPI y nginx no lo publica. Exige `Authorization: Bearer <INTERNAL_INTROSPECTION_SECRET>`
(credencial de servicio, mínimo 32 caracteres, comparada en tiempo constante); sin
la variable el endpoint rechaza todo (`401`, falla cerrada). Una sesión de
usuario o un token `iop_…` responden `401`. Cuerpo: `{"token": "iop_…"}`.

- Válido: `200 {active: true, userId, organizationId, groupId|null, scopes: ["mlflow:read"|"mlflow:write"…], cacheTtlSeconds: 30}`.
- Cualquier otro caso (desconocido, revocado, vencido, sin scopes `mlflow:*`,
  usuario desactivado o con contraseña temporal pendiente, organización
  deshabilitada, membresía de organización o de grupo retirada):
  `200 {active: false, cacheTtlSeconds: 5}`, sin motivo.
- La respuesta lleva `Cache-Control: private, max-age=<cacheTtlSeconds>`; el
  gateway no debe cachear más de 30 s. La revocación y la pérdida de acceso se
  ven en la app de inmediato.
- `lastUsedAt` se actualiza sin bloquear la respuesta, como máximo una vez por
  minuto por token.

#### Handoff de acceso a MLflow e introspección de sesión (MLOPS-02)

La app (`https://invoiceops.aglai.dev`) y el gateway de MLflow (`https://mlflow-invoiceops.aglai.dev`)
comparten solo el dominio padre, así que cada uno guarda una cookie **host-only**. La cookie
`invoiceops_session` nunca lleva atributo `Domain` y no hay variable para cambiarlo (`SESSION_COOKIE_DOMAIN`
se eliminó: ningún entorno debe compartir la sesión con un subdominio hermano). Si una petición trae más de
una cookie `invoiceops_session` se trata como si no trajera ninguna (el gateway aplica la misma regla), para
que ambos lados nunca autentiquen sesiones distintas. El navegador entra a MLflow mediante un handoff por redirección:

1. El gateway redirige una navegación de navegador sin sesión a
   `GET /api/v1/mlflow/authorize?redirect_uri=<callback del gateway>&state=<aleatorio>` (navegador, cookie de sesión).
   Límite: 30 solicitudes por minuto por **sesión válida** (`429 RATE_LIMITED` con `Retry-After`). Una cookie
   inválida o ausente no abre un cupo propio: se cuenta contra la IP del cliente (30 por minuto), así que
   cambiar el valor de la cookie en cada intento no evade el límite.
2. `redirect_uri` debe ser **exactamente** `MLFLOW_PUBLIC_URL` + `/_gateway/callback`; en otro caso `400` y
   sin redirección. Sin sesión válida el endpoint redirige a `/` (la SPA aún no tiene un mecanismo de
   regreso al login: el usuario inicia sesión y vuelve a abrir MLflow). Con sesión guarda un código de un
   solo uso (256 bits, solo se guarda su SHA-256, TTL de 60 s, ligado al usuario y a la sesión de la app) y
   responde `302` al callback con `code` y `state`. `403` si la cuenta no tiene ningún contexto de MLflow.
3. El gateway canjea el código con `POST /internal/sessions/exchange` `{"code"}` (credencial de servicio):
   atómico y de un solo uso; `200 {active: true, sessionToken, expiresInSeconds}` o `200 {active: false}`
   (desconocido, repetido, vencido o sesión padre inexistente; sin motivo). El `sessionToken` (`mls_...`) es
   una **sesión hija solo-MLflow**: vive en su propia tabla, ninguna ruta de la app la acepta, dura como
   máximo 8 h y nunca más que la sesión padre. Se elimina con la sesión padre (logout, cambio de contraseña,
   desactivación, vencimiento) mediante una clave foránea en cascada. El canje bloquea primero la fila de la
   sesión padre y después la del código (mismo orden que el logout), para que ambos no se bloqueen entre sí.
   Las sesiones hijas vencidas se podan al emitir un código nuevo.
4. `POST /internal/sessions/introspect` `{"sessionToken": "<token hijo>"}` (misma credencial de servicio,
   fuera de `/api/v1`, no publicado por nginx) resuelve la hija: `200 {active: true, userId,
contexts: [{organizationId, groupId|null, label}], cacheTtlSeconds: 30}` (contexto de organización más
   uno por grupo, solo organizaciones habilitadas, misma regla que la emisión de tokens `mlflow:*`) o
   `200 {active: false, cacheTtlSeconds: 5}` sin motivo. Un token de sesión de la app nunca se resuelve aquí.
5. `POST /internal/sessions/revoke` `{"sessionToken"}` (credencial de servicio, `204`, idempotente) elimina
   una hija; el gateway lo llama en su propio logout.

Arranque: `INTERNAL_INTROSPECTION_SECRET` definido con menos de 32 o más de 512 caracteres, con espacios o
que no parezca generado al azar (hexadecimal con al menos 8 dígitos distintos o cualquier cadena con alta
entropía; se rechazan repeticiones como `aaaa…` o `changeme` repetido) impide el arranque (sin definir sigue
fallando cerrado). Lo mismo vale para `MODEL_API_SERVICE_TOKEN` y `GATEWAY_SERVICE_READ_TOKEN`, y las tres
credenciales presentes deben ser **distintas entre sí**: un valor repetido impide el arranque (el mensaje
nombra las variables, nunca el valor). Genera cada una con `openssl rand -hex 32`. `MLFLOW_PUBLIC_URL` debe ser un origen sin
credenciales, ruta, query ni fragmento y usar https cuando `NODE_ENV=production`; en otro caso el proceso no
arranca. Se normaliza igual que en el gateway (esquema y host en minúsculas, puerto por defecto omitido). Sin
definir, el handoff queda apagado (`/api/v1/mlflow/authorize` responde `503`). Las escrituras con cookie siguen
exigiendo `Origin` igual a `PUBLIC_ORIGIN`; el gateway aplica la misma regla con su propio origen.

Las cuatro rutas privadas `/internal/*` comparten un limitador por IP de las respuestas `401`: más de 20
credenciales incorrectas en un minuto desde la misma IP reciben `429` (`Retry-After: 60`), lo que acota las
pruebas por fuerza bruta y el ruido en el log. La credencial se compara primero: la correcta siempre pasa y nunca
consume cupo, así que un `X-Forwarded-For` falsificado no puede dejar fuera al gateway. Se desactiva junto con `AUTH_RATE_LIMIT_DISABLED` (solo local). nginx no
publica `/internal/*`: un test de contrato lee `apps/frontend/nginx.conf` y comprueba que ninguna ruta
con `proxy_pass` pueda recibirlo.

##### Rotación de los secretos de servicio

`INTERNAL_INTROSPECTION_SECRET` (backend y gateway), `MODEL_API_SERVICE_TOKEN` (backend y Model API) y
`GATEWAY_SERVICE_READ_TOKEN` (backend y gateway) se rotan de uno en uno, nunca los tres a la vez, y un
secreto solo se reutiliza entre sus dos extremos. Los servicios leen el secreto al arrancar, así que la
rotación implica un reinicio breve de ambos extremos y, durante ese intervalo, las llamadas entre ellos
responden `401` (fallan cerradas):

1. Genera el valor nuevo con `openssl rand -hex 32` y verifica que no coincide con ninguno de los otros dos.
2. Actualiza el archivo de entorno de producción (`/opt/invoiceops/invoiceops.env`, permisos `600`) con el
   valor nuevo en el proyecto de ambos extremos.
3. Reinicia primero el servicio que **recibe** la llamada y luego el que la **envía**, por ejemplo
   `docker compose -f compose.production.yml up -d backend` y a continuación el proyecto del gateway o de la
   Model API; reinicia `web` si se recreó el backend (nginx resuelve el nombre una sola vez).
4. Comprueba `GET /health/ready` y una introspección real (abrir MLflow desde la app); el log del backend no
   debe mostrar ráfagas de `internal.rate_limited`.
5. Si el backend rechaza el arranque con «must be different values», dos variables quedaron con el mismo
   valor: corrige la repetida.

Una credencial comprometida se rota de inmediato con este mismo procedimiento; no hay período de gracia con
dos valores válidos a la vez.

#### Sección «Modelos» y deployments (MLOPS-05)

Apagada por defecto: cada organización tiene el flag `mlEnabled` (columna `Organization.mlEnabled`,
`false` al migrar) que un ADMIN de la organización cambia con `PATCH /api/v1/organizations/{id}`
(`{mlEnabled: true}`); el perfil lo expone en `memberships[].organization.mlEnabled`. Con el flag
apagado la sección no se muestra y los endpoints responden `404` (igual que a un no miembro); el
resto de la app no cambia. El permiso nuevo `deployModels` (el «models:deploy» del ticket) es un
quinto flag independiente en las membresías de organización y de grupo, administrado como los demás
(`PUT .../permissions`); ningún rol lo concede. **Omitir `deployModels` en un `PUT .../permissions` (individual
o masivo, de organización o de grupo) deja el valor guardado sin cambios**, no lo pone en `false`: un cliente
anterior al flag no revoca el permiso sin querer (OpenAPI lo documenta en `InvoicePermissionsUpdate`). Al
**crear** una membresía sin `permissions.deployModels` sí vale `false`. La auditoría del cambio guarda el valor
efectivo resultante.

Equivalencias con los tickets: `deployModels` es el permiso `models:deploy` del ticket MLOPS-05; y `FAILED` es el
estado con el que la app guarda un deployment **rechazado** (`rejected`) por el gate oficial de la Model API (o
cuyo chequeo no terminó): `FAILED` = `rejected`, con sus razones en `gate.reasons`.

`mlEnabled` también gobierna el acceso a MLflow: con el flag apagado la organización no ofrece contexto de
MLflow, de modo que la emisión de tokens `mlflow:*`, la introspección de tokens (`POST /internal/api-tokens/introspect`)
y la introspección de sesión (`POST /internal/sessions/introspect`) responden «inactivo» (`active: false`) o
`403` según corresponda, y el handoff `GET /api/v1/mlflow/authorize` responde `403` si la cuenta no tiene
ningún contexto. Los demás tokens (facturas) no cambian. Cada cambio de `mlEnabled` queda en el log
(`audit.org_updated`) y en la tabla `PlatformAdministrativeAuditEvent` (evento `ORGANIZATION_UPDATED`, columnas
`mlEnabledFrom` y `mlEnabledTo` con el valor anterior y el nuevo; nulas en los demás eventos). Apagar el flag
descarga de la Model API los modelos de la organización en la siguiente pasada de mantenimiento (abajo); las
filas de deployment conservan su estado, así que al volver a encenderlo el modelo se recarga cuando haga falta.

Endpoints (solo sesión; un `Authorization: Bearer` responde `401`). El contexto es
`organizationId` (+ `groupId` opcional) y el workspace de MLflow (`org-<uuid>` / `grp-<uuid>`) lo
deriva el servidor, nunca el cliente:

- `GET /api/v1/models` modelos y versiones del contexto (lectura con el servicio de solo lectura del
  gateway) y enlace a la UI de MLflow (`MLFLOW_PUBLIC_URL/?context=<workspace>`). Cualquier miembro activo.
- `GET /api/v1/deployments` últimos 100 deployments del contexto con su reporte del gate. **Solo lee**: indica
  `loaded` (si la Model API lo sirve) pero no escribe nada ni descarga modelos; eso lo hace el mantenimiento
  periódico. `limits.activeCount` se cuenta en base de datos (todos los `ACTIVE` y `CHECKING` del ámbito), no
  sobre las 100 filas listadas.
- `POST /api/v1/deployments` `{organizationId, groupId?, registeredModel, version}` (requiere `deployModels`):
  registra una fila `CHECKING` (tope y límite de tasa dentro de la misma transacción serializable) y llama
  `PUT /deployments/{id}` de la Model API, que repite el gate oficial y carga solo si pasa (una sola
  evaluación del set oculto por despliegue). Responde `201` con `ACTIVE` o `FAILED` + razones (un rechazo
  del gate no es un error). Tope de activos por ámbito (`MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE`, 3):
  `409 DEPLOYMENT_LIMIT`. Límite de gates por ámbito y hora (`MODEL_DEPLOY_CHECK_MAX_PER_HOUR`, 10, contado
  en base de datos): `429 RATE_LIMITED` con `Retry-After`. Si no hubo conexión con la Model API
  (rechazada, DNS) o respondió `409 CAPACITY_EXCEEDED` el intento no deja rastro ni consume cupo; si
  respondió con error o no contestó a tiempo (el gate pudo correr) la fila queda `FAILED`
  (`MODEL_API_ERROR` / `CHECK_TIMEOUT`), cuenta para el límite por hora y se descarga lo que haya cargado.
  Un despliegue puede durar hasta 120 s (nginx corta a los 60 s: la ruta de deployments tiene su propio
  `proxy_read_timeout` en el frontend). Si el cliente se desconecta, la petición **no se cancela**: el backend
  termina el gate y deja la fila en `ACTIVE` o `FAILED`; solo una caída del proceso deja un `CHECKING`, que el
  mantenimiento (y el siguiente `POST` del ámbito) marca `FAILED` pasados 10 min. Reintentar el mismo
  `POST` es seguro: responde `409 CONFLICT` con `error.fields.deploymentId` y `error.fields.status` (`CHECKING`,
  `ACTIVE` o `QUARANTINED`), el estado actual de ese deployment, y no crea otro; el cliente lo consulta en
  `GET /api/v1/deployments`.
- `PATCH /api/v1/deployments/{id}?organizationId=…[&groupId=…]` `{inferenceEnabled}`: activa o desactiva el
  puntaje de facturas nuevas. Activar verifica que el modelo siga cargado y, si la Model API lo perdió
  (reinicio), lo recarga repitiendo el gate. Desactivar no descarga el modelo.
- `DELETE /api/v1/deployments/{id}?organizationId=…[&groupId=…]` descarga y marca `INACTIVE` (historial
  conservado, libera el cupo; idempotente).

Estados: `CHECKING`, `ACTIVE` (pasó el gate y está cargado), `INACTIVE`, `FAILED`, `QUARANTINED`
(la Model API lo puso en cuarentena; se quita y se vuelve a desplegar). Un `deploymentId` de otro
contexto responde `404`. Auditoría: tabla `DeploymentEvent` (DEPLOYED, DEPLOY_FAILED, ACTIVATED,
DEACTIVATED, REMOVED, QUARANTINED) y eventos `audit.deployment_*` en el log.

Mantenimiento periódico (tarea en el proceso del backend, cada `MODELS_RECONCILE_INTERVAL_MS`, 30 000 por
defecto; solo si la Model API está configurada; nunca dentro de un `GET`): marca `FAILED` los `CHECKING`
vencidos (10 min) y descarga lo que hubieran cargado, pone en `QUARANTINED` los deployments que la Model API
puso en cuarentena, descarga los modelos cargados cuya fila esté `FAILED`, `INACTIVE` o no exista (solo ids con
forma de UUID) y los de organizaciones con `mlEnabled` apagado. Además recarga de forma ansiosa (CR-621) los `ACTIVE` con inferencia activa y `mlEnabled` que la Model API ya no sirve (reinicio), con la misma `ensureLoaded` (una ejecución por deployment), concurrencia 2 y hasta 20 por pasada; un fallo solo se registra, de modo que la primera predicción tras un reinicio no paga el gate. Si la Model API no responde solo barre los
`CHECKING`. Cada pasada con cambios deja un log `models.reconciled` con los conteos; si la Model API no responde,
deja un `warn` `models.reconcile_unavailable` (como máximo uno cada 5 minutos). Las llamadas concurrentes
de recarga de un mismo deployment (`ensureLoaded`, que usa el worker de predicciones) comparten una sola
ejecución del gate.

Variables (todas vacías = sección sin configurar, sus endpoints responden `503` sin afectar nada más; una URL
sin su secreto, o un secreto de menos de 32 caracteres, impide arrancar): `MODEL_API_URL`,
`MODEL_API_SERVICE_TOKEN`, `MLFLOW_GATEWAY_INTERNAL_URL`, `GATEWAY_SERVICE_READ_TOKEN`,
`MLFLOW_PUBLIC_URL`, `MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE`, `MODEL_DEPLOY_CHECK_MAX_PER_HOUR`.
Las respuestas de los servicios internos se leen con un tope de 1 MiB. Al listar deployments (y al barrer
checks vencidos) se descarga de la Model API todo modelo cargado cuya fila esté `FAILED`, `INACTIVE` o
no exista (solo ids con forma de UUID).

### Predicciones automáticas (MLOPS-06)

Al crear una factura, en la **misma transacción**, se inserta una fila `InvoicePrediction` `PENDING` por
cada deployment `ACTIVE` con inferencia activa que aplique a la factura, solo si la organización tiene
`mlEnabled`. Aplican los deployments del mismo ámbito (misma organización y `scopeKey`) y los de nivel
organización (`scopeKey = "organization"`): una factura de un grupo la puntúan los deployments de ese grupo
**y** los de su organización; una factura sin grupo, solo los de la organización; un deployment de grupo
nunca puntúa facturas de otro grupo ni de la organización. Las features (`supplier_prior_*`) salen siempre
del ámbito de la factura, no del deployment. Los deployments elegibles se leen en una consulta corta **antes**
de abrir la transacción SERIALIZABLE de la factura (dentro de ella, esa lectura tomaría bloqueos de predicado
que chocarían con cualquier cambio concurrente de deployments o del flag `mlEnabled` y abortarían creaciones
no relacionadas con `RETRYABLE_CONFLICT`); dentro de la transacción solo hay `INSERT`s. Una lectura algo vieja
es inocua: el worker revisa de nuevo `mlEnabled` y el deployment al procesar, y la base de datos rechaza
cualquier fila que una un deployment de otra organización o de otro ámbito (ver abajo). La creación de la
factura no llama a la Model API, no se hace más lenta ni falla por ML. Sin deployments elegibles o con
`mlEnabled` apagado no se encola nada; no hay puntaje retroactivo (solo facturas creadas con el deployment ya activo).

Integridad en la base de datos: `InvoicePrediction(deploymentId, organizationId)` es una clave foránea compuesta
a `Deployment(id, organizationId)` (una predicción no puede apuntar a un deployment de otra organización) y un
trigger exige que `Deployment.scopeKey` sea el de la predicción (el de la factura) o `organization`; un
deployment de grupo nunca puntúa otro grupo. Lo cubre `prediction-integrity.postgres.test.ts`.

La fila es a la vez el job (outbox) y su resultado: única `(invoiceId, deploymentId)`, estados `PENDING`,
`SUCCEEDED`, `FAILED`, `SKIPPED`, con `attempts`, `lastErrorCode` (código, nunca texto de un servicio) y
`nextAttemptAt`. Un worker en el mismo proceso del backend (arranca solo si `MODEL_API_URL` está configurada)
reclama los jobs vencidos con `FOR UPDATE SKIP LOCKED` y los arrienda (`nextAttemptAt` +5 min), así dos
workers nunca toman el mismo job y uno que muere lo deja reclamable. Al procesar revisa de nuevo que la
factura no esté eliminada, que `mlEnabled` siga activo y que el deployment siga `ACTIVE` con inferencia
(si no, `SKIPPED`); envía a `POST /deployments/{id}/predict` los campos crudos de la factura (sin su
`businessStatus`, que es la etiqueta) y las facturas previas del mismo proveedor, del mismo ámbito, creadas
antes, no eliminadas, **las 5000 más recientes** como máximo (el tope del Model API). «Mismo proveedor» es
igualdad de `Invoice.supplierKey` (índice `organizationId, scopeKey, supplierKey, createdAt DESC`), calculado
con `supplierKey()` de `apps/backend/src/supplier-key.ts`: NFKC, minúsculas, split por el conjunto explícito
de espacios de `str.isspace()` de Python y unión con un espacio; es gemelo de `invoiceops_ml.contract.supplier_key`
y ambos se validan con `tests/fixtures/supplier_key_vectors.json` (copia idéntica en invoiceops-ml y en
`apps/backend/test/fixtures/`; deben mantenerse sincronizados). La columna es nullable: se llena al crear la
factura y, para filas existentes o insertadas por una versión anterior (rollback), con un backfill idempotente
que el backend ejecuta al arrancar (antes de iniciar el worker) o a pedido: en desarrollo con
`pnpm --filter @invoiceops/backend backfill:supplier-key` y en la imagen de producción, que no trae `pnpm` ni
`tsx`, con el script compilado: `docker compose -f compose.production.yml exec backend node dist/backfill-supplier-key-command.js`
(necesita `DATABASE_URL`, que el contenedor ya tiene; es idempotente y reanudable). Un índice parcial
(`WHERE "supplierKey" IS NULL`) mantiene barata la búsqueda de esas filas. Durante un despliegue gradual una
réplica antigua puede insertar facturas sin clave: el worker las empareja calculando `supplierKey()` al vuelo
sobre las filas sin clave del ámbito, de modo que las features no se sesgan mientras no corra el backfill.
**Límite de ese respaldo:** lee solo las 5000 filas sin clave más recientes del ámbito (de cualquier proveedor) y filtra
en memoria; si el ámbito tiene más de 5000 facturas sin clave, las previas más antiguas del proveedor pueden faltar y
las features quedan incompletas hasta que termine el backfill. Cada consulta que llega a ese tope registra el `warn`
`prediction.unkeyed_priors_capped` (`invoiceId`, `organizationId`, `threshold`), como máximo una vez cada 10 minutos
por organización y ámbito (cada proceso lleva su propia cuenta); si aparece, ejecuta el backfill.
Si el cuerpo superara 3,5 MiB (la Model API responde 413 por encima de 4 MiB) se descartan las previas más antiguas. `404 DEPLOYMENT_NOT_LOADED` llama `ensureLoaded` (MLOPS-05) y reintenta una
vez. Los errores por **indisponibilidad** de la Model API (`MODEL_API_UNREACHABLE`, `MODEL_API_TIMEOUT`,
`MODEL_API_UNAVAILABLE`, `INFERENCE_UNAVAILABLE` / `503`, incluido `503 BUSY` cuando su compuerta de descargas está llena, `MODEL_API_AUTH`) **no consumen intentos**: el job
vuelve a `PENDING` con backoff exponencial con jitter (`PREDICTION_RETRY_BASE_MS` × 2^(n-1), con tope
`PREDICTION_RETRY_MAX_MS`, 15 min) y solo falla (`FAILED`, `JOB_EXPIRED`) cuando supera su edad máxima
(`PREDICTION_MAX_JOB_AGE_MS`, 24 h desde su creación), de modo que una caída de la Model API de varios minutos
o de unas horas no pierde predicciones. El resto de errores reintentables (`MODEL_API_ERROR`,
`DEPLOYMENT_NOT_LOADED`, error del worker) sí consumen intentos hasta `PREDICTION_MAX_ATTEMPTS` y luego
`FAILED`. Un `400`/`413`/`422` (`INVALID_REQUEST`) de la Model API no mejora al reintentar: el job queda `FAILED` de inmediato con `lastErrorCode = INVALID_INPUT`. Un job que pierde su worker se reclama tras 5 min y, agotados sus intentos, queda `FAILED`
(`ATTEMPTS_EXHAUSTED`). Cada poll reclama como máximo `min(PREDICTION_BATCH_SIZE, PREDICTION_CONCURRENCY)`
jobs, todos los cuales empiezan de inmediato: un job reclamado detrás de uno lento ya habría gastado un intento
y parte de su arriendo sin haber empezado.
Procesar de nuevo un job `SUCCEEDED` no hace nada. Eliminar una factura salta sus jobs pendientes.
Al detener el proceso el worker aborta las llamadas en curso al Model API y devuelve todos sus jobs reclamados
(el intento no se consume); la tarea periódica de mantenimiento de modelos (`models.reconcile`) recibe la misma
señal de aborto y corta sus llamadas a la Model API y su pasada entre pasos, de modo que el proceso sale limpio dentro de los
10 s de `SHUTDOWN_DEADLINE_MS` y `compose.production.yml` da 20 s (`stop_grace_period`) antes del `SIGKILL`. El detalle de la UI
refresca (2 s hasta 10 s, máximo ~2 min) mientras alguna predicción esté `PENDING`.

`GET /api/v1/invoices/{invoiceId}` agrega `predictions` (modelo, versión, run, `deploymentScope`
`ORGANIZATION`/`GROUP`, probabilidad de rechazo, estado, código de error, fechas) solo si la organización tiene `mlEnabled`, con la misma autorización de
lectura de la factura. El detalle de la UI muestra el panel «Predicciones», con la etiqueta «Organización» o «Grupo» por modelo.

Variables (valores por defecto seguros): `PREDICTION_WORKER_DISABLED` (`false`), `PREDICTION_WORKER_POLL_MS`
(2000), `PREDICTION_MAX_ATTEMPTS` (5), `PREDICTION_CONCURRENCY` (4), `PREDICTION_BATCH_SIZE` (10),
`PREDICTION_RETRY_BASE_MS` (5000), `PREDICTION_RETRY_MAX_MS` (900000), `PREDICTION_MAX_JOB_AGE_MS`
(86400000), `PREDICTION_METRICS_INTERVAL_MS` (60000), `PREDICTION_FAILED_WARN_THRESHOLD` (10),
`PREDICTION_FAILED_WINDOW_MS` (900000) y `MODELS_RECONCILE_INTERVAL_MS` (30000). Un valor mal formado
(o `PREDICTION_RETRY_MAX_MS` menor que `PREDICTION_RETRY_BASE_MS`) impide arrancar.

#### Observabilidad de la cola y runbook (MLOPS-06)

Cada `PREDICTION_METRICS_INTERVAL_MS` el backend registra la línea JSON `prediction.queue` con los jobs
`PENDING` (`pendingCount`), la edad en segundos del más antiguo (`oldestPendingAgeSeconds`, ausente si no hay) y los
`FAILED` de la ventana (`failedInWindow`). Solo mide la cola viva y la ventana reciente, con dos lecturas por índice
(`InvoicePrediction(status, createdAt)` e `InvoicePrediction(status, updatedAt)`): no recorre el histórico
`SUCCEEDED`/`SKIPPED`, que crece sin límite (ver «Retención»). Cuando
`failedInWindow` alcanza `PREDICTION_FAILED_WARN_THRESHOLD` dentro de `PREDICTION_FAILED_WINDOW_MS` registra además
un `warn` `prediction.failed_spike` (con `windowSeconds` y `threshold`) sobre el que se puede alertar. Una cola sana
muestra `oldestPendingAgeSeconds` de pocos segundos; si crece sin parar, la Model API está caída o el worker
está apagado. Las reglas de alerta con los campos exactos están en `DEPLOY.md` (sección 12).

La misma vista, a mano (solo lectura; recorre la tabla completa, úsala con moderación si es muy grande):

```sql
SELECT "status", count(*) AS jobs, min("createdAt") AS oldest
FROM "InvoicePrediction" GROUP BY "status" ORDER BY "status";
```

```sql
SELECT "lastErrorCode", count(*) AS jobs, max("updatedAt") AS last_seen
FROM "InvoicePrediction" WHERE "status" = 'FAILED' AND "updatedAt" > now() - interval '24 hours'
GROUP BY "lastErrorCode" ORDER BY jobs DESC;
```

Reencolar jobs `FAILED` (por ejemplo, `JOB_EXPIRED` tras una caída larga de la Model API) es una operación manual
con acceso a la base de datos: pone el job de nuevo en `PENDING`, reinicia sus contadores y le da una vida
nueva (la edad máxima se cuenta desde `createdAt`, así que también se renueva). Solo para predicciones cuya
factura siga vigente (el worker las salta si fue eliminada) y cuyo deployment siga `ACTIVE`:

```sql
UPDATE "InvoicePrediction"
SET "status" = 'PENDING', "attempts" = 0, "unavailableRetries" = 0,
    "lastErrorCode" = NULL, "nextAttemptAt" = now(), "createdAt" = now(), "updatedAt" = now()
WHERE "status" = 'FAILED' AND "lastErrorCode" IN ('JOB_EXPIRED', 'ATTEMPTS_EXHAUSTED', 'MODEL_API_ERROR')
  AND "updatedAt" > now() - interval '48 hours';
```

Ejecútalo con el backend en marcha (el worker toma los jobs en el siguiente poll) y revisa después
`prediction.queue`. Si los jobs volvieron a fallar por la misma causa, resuelve primero la Model API.

#### Retención de `InvoicePrediction`

La tabla **no se limpia automáticamente**: cada factura con ML activo agrega una fila por deployment y nada las
borra (el worker nunca elimina). `SUCCEEDED` es el resultado que muestra el detalle de la factura, así que la
política es una decisión del operador y se ejecuta **a mano**, con acceso a la base de datos. La propuesta:

| Estado              | Conservar                  | Por qué                                                                              |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `PENDING`           | siempre                    | Es la cola viva: nunca se borra a mano.                                              |
| `FAILED`, `SKIPPED` | 90 días desde `updatedAt`  | Diagnóstico; el runbook solo reencola `FAILED` de las últimas 48 h.                  |
| `SUCCEEDED`         | 365 días desde `updatedAt` | Es el dato que ve el usuario; al borrarlo la factura deja de mostrar esa predicción. |

Borra por lotes y repite cada sentencia hasta que informe `DELETE 0`. `FAILED` y `SKIPPED` van en sentencias
**separadas** con igualdad de estado: con `status IN ('FAILED', 'SKIPPED')` el índice `(status, updatedAt)` no
puede entregar las filas ordenadas por `updatedAt` (son dos rangos), así que cada lote leía y ordenaba todas las
filas vencidas antes de aplicar el `LIMIT`. Con una sola igualdad el planificador puede recorrer el índice en orden y
detenerse al llenar el lote (medido en PostgreSQL 17 con 500 mil filas: `Index Scan using
"InvoicePrediction_status_updatedAt_idx"` sin `Sort`, 10 mil filas leídas, frente a un `Sort` de todas las filas que
cumplen la condición con `IN`; si quedan pocas filas vencidas el planificador elige un `Bitmap Index Scan` más un
`Sort` pequeño, que también usa el índice). Ambos lotes usan el índice y no bloquean la cola. Esto vale para la selección del lote (la subconsulta con
`ORDER BY "updatedAt" LIMIT`); el `DELETE` externo (`WHERE "id" IN (…)`) puede usar un recorrido secuencial o un
`Hash Join` según el tamaño de la tabla, y es el costo esperado de borrar las filas ya elegidas:

```sql
DELETE FROM "InvoicePrediction"
WHERE "id" IN (
  SELECT "id" FROM "InvoicePrediction"
  WHERE "status" = 'FAILED' AND "updatedAt" < now() - interval '90 days'
  ORDER BY "updatedAt" LIMIT 10000
);
```

```sql
DELETE FROM "InvoicePrediction"
WHERE "id" IN (
  SELECT "id" FROM "InvoicePrediction"
  WHERE "status" = 'SKIPPED' AND "updatedAt" < now() - interval '90 days'
  ORDER BY "updatedAt" LIMIT 10000
);
```

```sql
DELETE FROM "InvoicePrediction"
WHERE "id" IN (
  SELECT "id" FROM "InvoicePrediction"
  WHERE "status" = 'SUCCEEDED' AND "updatedAt" < now() - interval '365 days'
  ORDER BY "updatedAt" LIMIT 10000
);
```

Ninguna otra tabla referencia a `InvoicePrediction`, así que el borrado no necesita nada más. Tras una limpieza grande
ejecuta `VACUUM (ANALYZE) "InvoicePrediction";` **con el rol dueño** (`POSTGRES_USER`): el rol de la aplicación
no es dueño de la tabla, y `VACUUM` sobre una tabla ajena se omite con un `WARNING` (`skipping ... only table or
database owner can vacuum it`) sin error visible. Si no lo ejecutas, el autovacuum de PostgreSQL hace el mismo trabajo
más tarde, sin que tengas que hacer nada. Si no aplicas ninguna política, el gauge sigue siendo barato (solo lee la cola viva y la
ventana de `FAILED`); lo que crece es el almacenamiento: mide el tamaño con
`SELECT pg_size_pretty(pg_total_relation_size('"InvoicePrediction"'));`.

#### Notas de migración de MLOps (`20261101…`, `20261126…`, `20261127…` y `20261128…`)

- **Corrección sobre `20261101000000_api_token_mlflow_scopes` (CR-521).** El comentario de esa migración dice que
  revertir la aplicación es seguro porque los dos valores nuevos del enum «quedan sin usar» en la versión
  anterior. Es incorrecto para los datos: PostgreSQL no puede quitar un valor de un enum, y la versión anterior de
  la aplicación **falla con `P2023`** (valor de enum desconocido) al leer cualquier fila de `ApiToken` cuyo
  `scopes` contenga `mlflow:read` o `mlflow:write`, también las revocadas o vencidas (el listado de tokens las
  incluye). La migración ya está aplicada y su checksum impide editar el comentario, así que la corrección vive
  aquí y en DEPLOY.md §9. Antes de volver a una versión anterior a `20261101…`, con el rol dueño
  (`POSTGRES_USER`, no el rol de la aplicación) elimina esos tokens y avisa a las personas afectadas de que deben
  volver a emitirlos al actualizar de nuevo (los tokens con scopes de facturas y MLflow a la vez también se
  eliminan):

```sql
BEGIN;
SELECT count(*) AS mlflow_tokens FROM "ApiToken" WHERE "scopes" && ARRAY['mlflow:read', 'mlflow:write']::"ApiTokenScope"[];
DELETE FROM "ApiToken" WHERE "scopes" && ARRAY['mlflow:read', 'mlflow:write']::"ApiTokenScope"[];
COMMIT;
```

Revocar (`revokedAt`) no basta, porque la fila sigue leyéndose. Lo cubre `api-token-rollback.postgres.test.ts`
(ejecuta este SQL) y `api-token-rollback.contracts.test.ts` (README y DEPLOY.md mantienen el paso).

- Las migraciones ya aplicadas **no se editan ni se pueden volver a ejecutar a mano**: Prisma registra cada una
  y no repite ninguna. En particular `20261126000000_prediction_org_deployment_on_group_invoice` reemplazó la
  clave compuesta `(deploymentId, organizationId, scopeKey)` por una clave simple y **no es re-ejecutable**
  (su `ADD CONSTRAINT` no tiene guarda: una segunda ejecución falla porque la clave ya existe); su defecto (una predicción podía unir
  una factura de la organización A con un deployment de la B) se corrige hacia adelante con una migración nueva.
- `20261127000000_prediction_integrity_and_audit` aún no estaba desplegada y es **idempotente** (todas sus
  sentencias tienen guardas: `IF NOT EXISTS`, `DROP … IF EXISTS`, una comprobación de la restricción sobre su tabla),
  de modo que aplicarla otra vez, por ejemplo a mano tras una ejecución parcial, no cambia nada ni falla. Hace:
  `UNIQUE (id, organizationId)` en `Deployment`; clave foránea compuesta
  `InvoicePrediction(deploymentId, organizationId)` → `Deployment(id, organizationId)` creada `NOT VALID` y validada
  después (`VALIDATE CONSTRAINT` toma un bloqueo `SHARE ROW EXCLUSIVE` sobre `InvoicePrediction` y sobre `Deployment`, que
  **impide escribir** en ambas tablas mientras recorre todas las filas de `InvoicePrediction`; como Prisma corre la migración
  en una sola transacción, el bloqueo se mantiene hasta el `COMMIT` de la migración completa, no solo durante la validación, y las
  lecturas siguen); elimina la clave
  foránea simple y el índice único `(id, organizationId, scopeKey)` que ya no se usa; trigger
  `InvoicePrediction_deployment_scope_guard`; columna `InvoicePrediction.unavailableRetries`; índice parcial
  `Invoice_supplierKey_null_idx` y las columnas `mlEnabledFrom` / `mlEnabledTo` del audit.
- Si existiera una fila de `InvoicePrediction` que una organización con el deployment de otra, la validación
  falla y la migración entera se revierte (corre en una sola transacción); corrige o borra esas filas y repite.
  Un test automático (`migration-populated.postgres.test.ts`) aplica las migraciones sobre una base ya poblada.
- **Bloqueo de `Invoice`**: crear un índice (el parcial de arriba, y antes `Invoice_organizationId_scopeKey_supplierKey_createdAt_idx`
  de `20261121…`) toma un bloqueo que impide **escribir** en `Invoice` mientras se construye (las lecturas siguen).
  Prisma ejecuta cada migración en una transacción, así que no puede usar `CREATE INDEX CONCURRENTLY`. El índice
  parcial solo guarda las filas sin `supplierKey`, pero igual debe leer toda la tabla: medido en un contenedor
  PostgreSQL 17 local con una tabla de 1 millón de filas (peor caso, todas sin clave) tarda cerca de 1,5 a 2 s, es
  decir, del orden de **1 s por cada 500 mil facturas** (con las columnas reales de `Invoice`, más anchas, cuenta
  con ~1 s por cada 300 mil). Con pocas facturas es instantáneo, pero con millones el bloqueo dura segundos.
  Aplica las migraciones en un momento de poco tráfico de creación de facturas.
- `20261128000000_prediction_queue_metrics_indexes` es **idempotente** (`CREATE INDEX IF NOT EXISTS`) y crea
  `InvoicePrediction(status, createdAt)` e `InvoicePrediction(status, updatedAt)` para el gauge de la cola.
  También bloquea las escrituras de `InvoicePrediction` (la creación de facturas con ML activo) mientras construye: medido,
  1,5 millones de filas tardan unos 7 s por índice, así que con una tabla grande aplícala en una ventana de poco tráfico. Con el
  gauge sobre ese conjunto (300 `PENDING`, 50 `FAILED` recientes) cada lectura pasó de un barrido completo de la tabla
  (~600 ms, 33 mil páginas) a un `Index Only Scan` de 0,1 ms y 5 a 7 páginas.
- **Comentario desactualizado en `20261121…`.** La migración `20261121000000_invoice_supplier_key` dice que las
  filas con `supplierKey` NULL «no se usan como priors hasta que se rellenan» con el backfill. Ese comentario está
  desactualizado y su checksum impide editarlo: el worker calcula la clave al vuelo para las predicciones previas con
  `supplierKey` NULL, así que esas filas sí cuentan sin esperar al backfill.
- Despliegue gradual: una réplica antigua puede insertar facturas sin `supplierKey` y no conoce
  `unavailableRetries`; ambos casos están cubiertos (el worker calcula la clave al vuelo y la columna tiene valor
  por defecto). Revertir la aplicación a la versión anterior es seguro **respecto de estas columnas**: la versión
  anterior las ignora y las garantías de la base solo rechazan lo que esa versión nunca escribe. **No es seguro si
  existen tokens de API con scopes `mlflow:*`**; ver la corrección de `20261101…` más arriba (primer punto de esta sección).

### Documentación interactiva (Swagger UI)

`/docs` (público, sin cookie; redirige a `/docs/`) sirve Swagger UI desde los
archivos locales de `swagger-ui-dist` (sin CDN) sobre el `/openapi.json` del
mismo origen. Para probar las operaciones de facturas desde el navegador:
emite un token en **Tokens de API** (se muestra **una sola vez**: cópialo
entonces), abre `/docs`, pulsa **Authorize**, pega el secreto `iop_…` en
`bearerAuth`, **Authorize** y **Close**; luego abre `POST /api/v1/invoices`,
**Try it out**, completa `Idempotency-Key` y el cuerpo (hay un ejemplo de
alcance organización y otro de grupo) y pulsa **Execute**. La autorización
vive solo en memoria: al recargar hay que pegar el token otra vez. Desde `/docs`
nunca se envía la cookie de sesión (aunque estés conectado a la app), así que
solo funciona lo que acepta Bearer; el resto responde `401`. Todas las
respuestas de `/docs` llevan `Content-Security-Policy: default-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';
frame-ancestors 'none'` (sin scripts en línea ni orígenes externos).

### Clientes de aula (curl y Python)

La guía [`docs/recovery-local-api.md`](docs/recovery-local-api.md) explica cómo
crear y leer facturas con un token desde `examples/recovery/create-invoice.sh`
(bash + curl) y `examples/recovery/create-invoice.py` (Python estándar): alcance
organización y grupo, idempotencia, revocación y manejo de errores. Solo aceptan
URLs de loopback y leen el token sin eco. `pnpm test:recovery:clients` ejecuta
esos mismos archivos contra el backend real y PostgreSQL aislado.

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
PASSWORD_REUSE`). Si la contraseña actual es incorrecta responde `400
INVALID_CURRENT_PASSWORD` y la sesión sigue válida; `401` queda solo para una sesión
inválida, vencida o deshabilitada. En una sola transacción actualiza el hash, quita el cambio
obligatorio, elimina todas las sesiones del usuario, crea una sesión nueva (cookie
`Set-Cookie` rotada), revoca sus API tokens y registra auditoría. Login y cambio de
contraseña se serializan por usuario con un bloqueo de fila (`SELECT … FOR NO
KEY UPDATE`, que no choca con la clave foránea de una factura creada con un
token), de modo que un login iniciado antes del cambio no deja sesión con la
credencial anterior. Con `mustChangePassword` el perfil, el cambio de contraseña y
el logout (y el `PATCH /api/v1/profile` heredado) son las únicas rutas
permitidas; el resto responde `403 ONBOARDING_REQUIRED`. La sesión de un usuario
con contraseña temporal caduca como máximo cuando caduca la temporal. Una petición
con `Authorization` y cookie de sesión responde `400 AMBIGUOUS_AUTH`; `Authorization`
sola responde `401` (un token Bearer solo se acepta en las cuatro operaciones de facturas). El perfil incluye `memberships`: por
organización, `role`, `permissions` y los grupos de esa organización con sus
`permissions` y `effective` (presentación; el servidor decide). No existe `contexts`.

`POST /api/v1/auth/login` y `POST /api/v1/auth/change-password` limitan los
intentos mediante memoria local (`logout` no tiene límite; el de
`change-password` se describe tras este bloque). Política de login: cuenta únicamente
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

`change-password` usa el mismo limitador (mismo máximo y ventana, y se desactiva con
`AUTH_RATE_LIMIT_DISABLED` solo en local) con **una clave por sesión** (hash del
token de la cookie, nunca el token): solo cuentan las contraseñas actuales
**incorrectas** (`400 INVALID_CURRENT_PASSWORD`). Superado el máximo responde `429
RATE_LIMITED` sin llamar al servicio y la sesión sigue válida. Un cambio correcto, un
error de validación, una sesión vencida o un fallo del servidor no consumen cupo. Así
una sesión robada no puede adivinar la contraseña actual.

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

Reglas de `email` y `username` (CR-310): se recortan los espacios; `email` debe
ser una dirección válida de hasta 254 caracteres y se guarda en minúsculas;
`username` admite hasta 64 caracteres; ninguno puede contener el carácter NUL;
un valor en blanco o `null` los borra (se guarda `null`). Ambos son únicos entre
usuarios (los `null` no colisionan): si otra persona ya los usa, responde
`409 USER_CONFLICT` y no cambia nada.
El `username` es único distinguiendo mayúsculas y minúsculas; el `email` se compara recortado y en minúsculas.

### Grupos de la organización

`Group` y `GroupMembership` pertenecen a una organización. Un usuario puede
pertenecer a varios grupos de la misma organización; la base de datos impide
pares grupo-usuario duplicados y exige que todo miembro de un grupo tenga una
`OrganizationMembership` en la organización de ese grupo.

Los usuarios autenticados pueden llamar a `GET /api/v1/groups` (heredado, sin
documentar) para listar solo sus propios grupos (`id`, `name`, `description`,
`organization`) en orden determinista por organización y grupo; no incluye a las
personas del grupo (el listado de miembros es para el `ADMIN` de la organización
y el administrador de plataforma). La gestión de grupos vive bajo
`/api/v1/organizations/:organizationId/groups`; solo un `ADMIN` vigente de esa
organización (o el administrador de plataforma) puede crear un grupo y agregar o
quitar miembros. Las cuatro banderas de permiso de facturas están en
`OrganizationMembership` y `GroupMembership` (por defecto `false`) y se reemplazan
con `PUT .../memberships/:userId/permissions` y
`PUT .../groups/:groupId/memberships/:userId/permissions`; `Group` no tiene
ninguna y `PATCH .../groups/:groupId` fue eliminado. Los permisos efectivos en un
grupo son las banderas de la organización O las del grupo; en el alcance de
organización, solo las de la organización. El servidor valida la sesión vigente y
la organización del recurso en cada solicitud, y responde de forma segura ante
sesiones ausentes, no miembros y usuarios con rol USER.

#### Desactivación de usuarios

Solo el administrador de plataforma desactiva o reactiva usuarios:
`POST /api/v1/admin/users/{userId}/deactivation` y
`DELETE /api/v1/admin/users/{userId}/deactivation` (ambas responden `200` con
`{ user: { id, name, rut, disabledAt } }`; son idempotentes y solo escriben
auditoría `USER_DEACTIVATED`/`USER_REACTIVATED` cuando hay cambio). Errores:
`401`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 SELF_ACTION_FORBIDDEN` (el actor
se apunta a sí mismo) y `409 LAST_ADMIN_REQUIRED` (último ADMIN habilitado de una
organización). Un usuario desactivado conserva sus membresías, pierde todas las
sesiones y tokens de API activos, no puede iniciar sesión (mismo `401 Invalid
credentials` que una contraseña errónea) y sus cookies previas devuelven `401`;
al reactivarlo debe iniciar sesión de nuevo. El servidor registra `lastActiveAt`
en cada login exitoso y, como máximo cada 5 minutos, en solicitudes autenticadas.
Las vistas de usuarios exponen `lastActiveAt` (instante ISO 8601 de la última
actividad, `null` si nunca la hubo) a quien ya puede ver `recentlyActive`; la UI
muestra «Activo hace …» con un punto de color (menos de 1 día verde, menos de 7
días amarillo, 7 días o más rojo, nunca gris). Un usuario desactivado conserva su
`lastActiveAt` real con `recentlyActive` falso.

#### Directorio y mantenimiento de usuarios

Solo el administrador de plataforma (`401` sin sesión, `403 FORBIDDEN` para el
resto; los cuerpos y parámetros inválidos responden `400` antes del `403`):

- `GET /api/v1/admin/users?search&status&page&pageSize` lista usuarios
  (incluidos el administrador y los desactivados) como
  `{ users: [{ id, name, rut, disabledAt, recentlyActive, lastActiveAt }], page, pageSize, total }`,
  ordenados por nombre. `search` busca por nombre (sin distinguir mayúsculas) o por
  fragmento de RUT escrito con o sin puntos y guion; `status` es
  `all|active|disabled` (por defecto `all`); `pageSize` va de 1 a 100 (por defecto
  20). No acepta parámetros desconocidos. `recentlyActive` indica actividad en los
  últimos 15 minutos; `lastActiveAt` es el instante de la última actividad
  (refrescado como máximo cada 5 minutos) o `null` si nunca la hubo.
- `GET /api/v1/admin/users/{userId}` devuelve el usuario y sus membresías de
  organización y grupo con sus permisos de facturas (`404 NOT_FOUND` si no existe).
- `PATCH /api/v1/admin/users/{userId}` cambia `name` y/o `rut` (al menos uno). Un
  RUT nuevo revoca sesiones y tokens de API del usuario; `409 USER_CONFLICT` si el
  RUT ya existe y `409 SELF_ACTION_FORBIDDEN` si el actor cambia su propio RUT (su
  nombre sí puede cambiarlo). Sin cambios responde `200` sin auditoría; con cambio
  escribe `USER_UPDATED`.
- `POST /api/v1/admin/users/{userId}/password-reset` (cuerpo `{}` o
  `{ temporaryPassword }` de 8 a 256 caracteres) responde `200` con
  `{ temporaryPassword?, expiresAt }` y `Cache-Control: no-store`; la contraseña solo
  se devuelve si la generó el servidor y vence a las 24 horas. Borra todas las
  sesiones, revoca los tokens de API, exige cambiarla al iniciar sesión y escribe
  `PASSWORD_RESET` (nunca la contraseña). `409 SELF_ACTION_FORBIDDEN` sobre uno
  mismo; un usuario desactivado sigue desactivado.

PATCH y password-reset corren en transacciones SERIALIZABLE (`503 RETRYABLE_CONFLICT`
cuando se agotan los reintentos).

#### Organizaciones, miembros y usuarios (paginación)

Todas las listas paginadas comparten el mismo contrato: `page` (desde 1, hasta
10.000) y `pageSize` (1 a 100, por defecto 20), sin parámetros desconocidos ni
repetidos (`400` antes de la autoridad), y responden `{ <items>, page, pageSize, total }`.

- `GET /api/v1/organizations?search&page&pageSize` es paginado para todos: `search`
  filtra por nombre (sin distinguir mayúsculas; `%` y `_` son literales), orden por
  nombre e id. El administrador de plataforma ve todas; el resto, las propias.
  Respuesta `{ organizations, page, pageSize, total }` (cambio incompatible: antes
  era `{ organizations }`).
- `GET /api/v1/organizations/{organizationId}/memberships?page&pageSize&userIds` (solo
  ADMIN o plataforma) responde `{ memberships, page, pageSize, total }`; el `user` de
  cada elemento suma `disabled`, `recentlyActive` (falso si está desactivado) y
  `lastActiveAt` (`null` si nunca hubo actividad).
  `userIds` (opcional) son de 1 a 200 UUID distintos separados por coma: la página
  contiene solo esos miembros (mismo orden y forma; los ids que no son miembros
  simplemente no aparecen y `total` cuenta solo los coincidentes). Es lo que usan
  la pantalla de un miembro y la edición de permisos en bloque, para no depender de
  la primera página. Vacío, repetido, con duplicados, con valores que no son UUID o
  con más de 200 responde `400`.
- `GET /api/v1/organizations/{organizationId}/users?search&page&pageSize` (ADMIN o
  plataforma) responde `{ users: [{ id, name, rut, role }], page, pageSize, total }`,
  ordenado por nombre, RUT e id. `search` (opcional, 1..100 caracteres tras recortar
  espacios; vacío o más largo responde `400`) filtra por fragmento del nombre
  (sin distinguir mayúsculas) o del RUT escrito con o sin puntos y guion, igual que
  la búsqueda del directorio de plataforma; `%` y `_` son literales. Un carácter NUL (`%00`) en cualquier `search`, nombre o descripción responde `400 VALIDATION_ERROR` (PostgreSQL no puede guardarlo). `GET .../groups/{groupId}/memberships?page&pageSize` (ADMIN o
  plataforma) responde `{ memberships, page, pageSize, total }` con el mismo orden.
- `/members` es siempre la vista reducida (para cualquier rol); `/memberships` es la
  vista de ADMIN o plataforma, con `disabled`.
- `GET /api/v1/organizations/{organizationId}/members?page&pageSize` (nuevo; cualquier
  miembro con cualquier rol, o plataforma; otro caso `404` indistinguible de una
  organización inexistente) responde la vista reducida
  `{ members: [{ userId, name, email, recentlyActive, lastActiveAt }], page, pageSize, total }`,
  ordenada por nombre. Nunca expone RUT, rol, permisos ni `disabledAt`.
- `PATCH /api/v1/organizations/{organizationId}` cambia `name` y/o `description` (al
  menos uno; una descripción vacía o `null` la borra). El `slug` es inmutable: enviarlo
  o cualquier otro campo responde `400`. Solo ADMIN de la organización o plataforma
  (`403` para un miembro común, `404` para quien no pertenece). Responde
  `{ organization: { id, name, slug, description } }`; sin cambios es `200` sin
  auditoría, con cambio escribe `ORGANIZATION_UPDATED` (solo ids). Corre en
  transacción SERIALIZABLE (`503 RETRYABLE_CONFLICT`).
- `GET /api/v1/users/{userId}` (nuevo) está disponible para cualquier usuario
  autenticado con onboarding completo cuando el objetivo comparte una organización
  con quien consulta, es él mismo o quien consulta es el administrador de plataforma;
  en otro caso `404 NOT_FOUND` indistinguible de un usuario inexistente. Responde
  `{ user: { id, name, email, recentlyActive, lastActiveAt }, sharedOrganizations: [{ id, name }] }`
  (para plataforma, las organizaciones del objetivo). Nunca expone RUT, credenciales,
  estado de onboarding, `disabledAt`, roles ni permisos; un usuario desactivado sigue
  visible con `recentlyActive` falso y su `lastActiveAt` real.

Los cuerpos JSON de las solicitudes están limitados a 16 kB (`413 PAYLOAD_TOO_LARGE`
por encima). Solo las cinco operaciones por lote aceptan hasta 64 kB, suficiente
para 200 miembros con sus propios permisos: `POST /api/v1/admin/users`,
`POST /api/v1/organizations/:organizationId/users`,
`POST .../groups/:groupId/memberships/bulk` y los dos
`PUT .../memberships/permissions` masivos. `POST /api/v1/admin/users` acepta como
máximo 50 membresías y **200 asignaciones de grupo en total** entre todas ellas
(`400` por encima; el cuerpo válido más grande, con UUID, todas las banderas y el
nombre y la contraseña más largos, ronda los 42 kB, así que siempre cabe en
64 kB). Toda escritura de membresías (incluido el aprovisionamiento de usuarios)
corre en una transacción SERIALIZABLE con reintentos acotados y con jitter, y
responde `503 RETRYABLE_CONFLICT` con `Retry-After` cuando se agotan: repite la
solicitud. Cada cambio de membresía también se escribe en la tabla durable
`PlatformAdministrativeAuditEvent` en la misma transacción (una fila por miembro
afectado, solo con identificadores y las banderas nuevas).

El administrador de plataforma tiene autoridad **administrativa** sobre cualquier
organización o grupo (miembros, roles, grupos y permisos; `404` solo si la
organización no existe), pero nunca acceso a facturas: el resolutor de permisos
ignora la plataforma. Esta regla se aplica en el servidor y no depende de
permisos entregados por el cliente.

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

Las mutaciones autenticadas con cookie comprueban el mismo origen (`Origin`) en
un middleware central. Las solicitudes con la cookie de sesión deben incluir un
`Origin` idéntico al origen de la solicitud; las de otro origen reciben `403`
antes de llegar al manejador de la mutación. Vite y Nginx hacen proxy de `/api/`,
`/openapi.json` y `/docs` en el mismo origen del navegador que la aplicación.

### Policies de negocio versionadas

Las policies son owner-scoped por organización y contienen `version` y
`manualReviewThreshold` entre 0 y 1. Las individuales sólo las administra su
propietario; las grupales sólo un `ADMIN` de la organización. Se consultan,
crean y actualizan mediante `GET`, `POST` y `PATCH /api/v1/business-policies` en el
contexto `organizationId`, `ownerType` y `ownerId` (las facturas ya no lo usan).
