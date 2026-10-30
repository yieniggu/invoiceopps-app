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
   (`deleteOwnInvoices` o `deleteOthersInvoices`); aún no hay crear desde la
   interfaz.
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
Las pruebas E2E del navegador (Playwright, pila real contra la base de pruebas aislada) se ejecutan con `pnpm test:e2e`; ver «Pruebas E2E del navegador» en [`LOCAL_RUN.md`](LOCAL_RUN.md).

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

The runner creates a new isolated container with a unique role and password, a
loopback-only ephemeral port, and bounded memory and temporary storage. It does
not use `.env`, persistent volumes, or the Compose `db-test` service. It applies
the migrations (`20261026000000_initial_recovery_p0` must be the first one, then
`20261028000000_user_status_activity`, then `20261029000000_invoice_events`), verifies the `_prisma_migrations` ledger name, checksum and
status against the files on disk, and runs the 24 organization-persistence
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
sola responde `401` (los Bearer llegan con RP0-16). El perfil incluye `memberships`: por
organización, `role`, `permissions` y los grupos de esa organización con sus
`permissions` y `effective` (presentación; el servidor decide). No existe `contexts`.

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

Reglas de `email` y `username` (CR-310): se recortan los espacios; `email` debe
ser una dirección válida de hasta 254 caracteres y se guarda en minúsculas;
`username` admite hasta 64 caracteres; ninguno puede contener el carácter NUL;
un valor en blanco o `null` los borra (se guarda `null`). Ambos son únicos entre
usuarios (los `null` no colisionan): si otra persona ya los usa, responde
`409 USER_CONFLICT` y no cambia nada.
El `username` es único distinguiendo mayúsculas y minúsculas; el `email` se compara recortado y en minúsculas.

### Organization groups

`Group` and `GroupMembership` are organization-scoped. A user can belong to
multiple groups in the same organization, while the database prevents duplicate
group-user pairs and enforces that every group member has an
`OrganizationMembership` in that group organization.

Authenticated users can call `GET /api/v1/groups` (legacy, undocumented) to list only
their own groups (`id`, `name`, `description`, `organization`) in deterministic
organization and group order; it does not include the people in them (member
listings are for the organization `ADMIN` and the platform administrator). Group
management is scoped under `/api/v1/organizations/:organizationId/groups`; only a
current `ADMIN` of that organization (or the platform administrator) can create a group
and add or remove members. The four invoice permission flags live on
`OrganizationMembership` and `GroupMembership` (default `false`) and are replaced with
`PUT .../memberships/:userId/permissions` and
`PUT .../groups/:groupId/memberships/:userId/permissions`; `Group` has none and
`PATCH .../groups/:groupId` was removed. Effective permissions in a group are
organization OR group flags; at organization scope, organization flags only. The server validates the current session and resource
organization for every request, returning safe authorization responses for
absent sessions, non-members, and users with the USER role.

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

#### Directorio y mantenimiento de usuarios

Solo el administrador de plataforma (`401` sin sesión, `403 FORBIDDEN` para el
resto; los cuerpos y parámetros inválidos responden `400` antes del `403`):

- `GET /api/v1/admin/users?search&status&page&pageSize` lista usuarios
  (incluidos el administrador y los desactivados) como
  `{ users: [{ id, name, rut, disabledAt, recentlyActive }], page, pageSize, total }`,
  ordenados por nombre. `search` busca por nombre (sin distinguir mayúsculas) o por
  fragmento de RUT escrito con o sin puntos y guion; `status` es
  `all|active|disabled` (por defecto `all`); `pageSize` va de 1 a 100 (por defecto
  20). No acepta parámetros desconocidos. `recentlyActive` indica actividad en los
  últimos 15 minutos; `lastActiveAt` nunca se expone.
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
  cada elemento suma `disabled` y `recentlyActive` (falso si está desactivado).
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
  `{ members: [{ userId, name, email, recentlyActive }], page, pageSize, total }`,
  ordenada por nombre. Nunca expone RUT, rol, permisos, `disabledAt` ni `lastActiveAt`.
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
  `{ user: { id, name, email, recentlyActive }, sharedOrganizations: [{ id, name }] }`
  (para plataforma, las organizaciones del objetivo). Nunca expone RUT, credenciales,
  estado de onboarding, `disabledAt`, roles ni permisos; un usuario desactivado sigue
  visible con `recentlyActive` falso.

JSON request bodies are limited to 16 kB (`413 PAYLOAD_TOO_LARGE` above it).
Only the five batch operations accept up to 64 kB, enough for 200 members with
their own permissions: `POST /api/v1/admin/users`,
`POST /api/v1/organizations/:organizationId/users`,
`POST .../groups/:groupId/memberships/bulk` and the two bulk
`PUT .../memberships/permissions`. `POST /api/v1/admin/users` accepts at most 50
memberships and **200 group grants in total** across all of them (`400` above
that; the largest valid body, with UUIDs, all flags and the longest name and
password, is about 42 kB, so it always fits in 64 kB). Every membership write (user provisioning
included) runs in a SERIALIZABLE transaction with bounded, jittered retries and
answers `503 RETRYABLE_CONFLICT` with `Retry-After` when they run out: repeat the
request. Every membership change is also written to the durable
`PlatformAdministrativeAuditEvent` table in the same transaction (one row per
affected member, identifiers and the new flags only).

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
contexto `organizationId`, `ownerType` y `ownerId` (las facturas ya no lo usan).
