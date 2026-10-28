# Levantar InvoiceOps App en local

> Hay un único entorno local y una única base de datos: `invoiceops`, en el proyecto Compose `invoiceops-dev`. `invoiceops_recovery_test` existe solo para `pnpm test:recovery:postgres`.

Guía vigente para el estado de recuperación P0 (slice S0: sin MLflow, Model API,
blockchain ni evidencia). La app solo necesita PostgreSQL. Todos los comandos se
ejecutan desde la raíz de `invoiceops-app`.

Hay dos rutas que comparten la misma base de datos:

| Ruta                   | Backend y frontend                               | Cuándo usarla                         |
| ---------------------- | ------------------------------------------------ | ------------------------------------- |
| A. Desarrollo con pnpm | Procesos locales con recarga (`tsx watch`, Vite) | Programar y depurar                   |
| B. Todo en Docker      | Imágenes de backend y frontend (nginx)           | Probar el empaquetado como se entrega |

En ambas, PostgreSQL corre en Docker bajo el proyecto Compose `invoiceops-dev`,
publicado solo en loopback.

> Desde RP0-01 el esquema es una única migración consolidada en la base de
> desarrollo `invoiceops`; una base creada con las migraciones históricas no es
> compatible y debe recrearse con el reset del paso 3. El primer administrador
> se crea con `pnpm recovery:bootstrap` (paso 4).

## Requisitos

- Node 24 y pnpm 11 (`corepack enable`).
- Docker Desktop con Compose v2.
- Puertos libres en `127.0.0.1`: 5545 (PostgreSQL), 4380 y 5380 (ruta A) o
  5300 y 5174 (ruta B). Los puertos de Docker y de la base (5545, 5300, 5174) se
  cambian en `.env`; el backend de desarrollo usa `PORT` (por defecto 4380) y el
  proxy de Vite lo sigue; Vite escucha en 5380, fijo en `vite.config.ts`.

## 1. Configuración privada

Crea `.env` en la raíz solo si no existe. Está en `.gitignore`; no lo publiques.

```sh
if [ -e .env ]; then
  echo ".env ya existe; no se modificó."
else
  # El subshell evita que el umask restrictivo quede activo en tu terminal.
  (
    umask 077
    cat > .env <<EOF
POSTGRES_USER=invoiceops
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=invoiceops
LOCAL_APP_DB_PORT=5545
LOCAL_BACKEND_PORT=5300
LOCAL_FRONTEND_PORT=5174
EOF
  ) && echo ".env creado."
fi
```

Carga las variables en la shell actual y construye `DATABASE_URL` para los
comandos que corren fuera de Docker. No la imprimas.

```sh
set -a; . ./.env; set +a
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${LOCAL_APP_DB_PORT}/invoiceops?schema=public"
```

Hay una sola base de desarrollo: `invoiceops` (la misma `POSTGRES_DB` del
servidor, también en la ruta B). `invoiceops_recovery_test` existe solo para
`pnpm test:recovery:postgres` y nunca se usa para desarrollar.

Repite este bloque en cada terminal nueva que use la base.

## 2. Dependencias y cliente Prisma

```sh
pnpm install
pnpm generate
```

## 3. PostgreSQL y base de desarrollo

```sh
docker compose -p invoiceops-dev --env-file .env \
  -f docker-compose.yml -f compose.invoiceops-local.yml up -d --wait db
printf '%s\n' "${DATABASE_URL#*@}"   # esperado: 127.0.0.1:<LOCAL_APP_DB_PORT>/invoiceops?schema=public
pnpm recovery:local:reset -- --confirm-reset=invoiceops
```

> Borra todos los datos de `invoiceops`; no lo ejecutes si quieres conservarlos.
> Precondición: `DATABASE_URL` (paso 1) debe apuntar a
> `127.0.0.1:$LOCAL_APP_DB_PORT/invoiceops`. El `printf` anterior muestra solo
> `host:puerto/base` sin credenciales; si no coincide, no continúes.

El reset **destruye y recrea** la base de desarrollo `invoiceops` (se pierden
sus datos) y aplica la migración consolidada. Antes de conectarse exige: protocolo `postgres`/`postgresql`, host
`localhost`, `127.0.0.1`, `::1` o socket unix, nombre de base exactamente
`invoiceops` o `invoiceops_recovery_test` y la confirmación
`--confirm-reset=<nombre>`. Imprime solo `host:puerto/base`, nunca credenciales.
Si falla una guarda termina con código distinto de cero sin tocar la base.

Esperado: `db` saludable y `reset: consolidated migration applied`. Las
migraciones nunca corren solas al arrancar el backend. En la ruta B el contenedor
backend usa la base `invoiceops` (usuario y contraseña de `.env`) definida en
`docker-compose.yml`, por lo que el reset debe ejecutarse antes de levantar el
backend.

## 4. Primer usuario y administrador de plataforma

Con `DATABASE_URL` cargada (paso 1) y la base recién reseteada:

```sh
pnpm recovery:bootstrap
```

El comando pide nombre, RUT (válido, por ejemplo `11111111-1`) y la contraseña
temporal dos veces, sin eco; nunca la acepta por argumentos ni por variables de
entorno y exige una terminal interactiva. En una sola transacción crea el
usuario (contraseña temporal de 24 horas, cambio obligatorio en el primer
ingreso) y la designación única de administrador de plataforma. Solo corre
contra una `DATABASE_URL` local (loopback o socket unix).

- Repetirlo con el mismo RUT responde «already initialized» (la salida del comando está en inglés) y no cambia nada.
- Con otro RUT se rechaza: no transfiere autoridad.
- `pnpm recovery:bootstrap --existing-user` designa a un usuario existente por
  RUT, solo si ya tiene una credencial utilizable (no pide contraseña): una
  contraseña temporal vencida o sin vencimiento no cuenta como utilizable.
- Si cierras la entrada (Ctrl-D) o interrumpes (Ctrl-C) durante un prompt, el
  comando termina con código 1 y un mensaje; no deja nada a medias.
- `pnpm recovery:bootstrap --help` documenta las opciones.

## 5A. Arrancar con pnpm (desarrollo)

Con `DATABASE_URL` cargada (paso 1):

```sh
pnpm dev
```

- Frontend: http://127.0.0.1:5380 (Vite reenvía `/api/` y `/openapi.json` al backend; `/health/*`
  queda solo en el backend).
- Backend: http://127.0.0.1:4380/health/ready

El backend escucha en `HOST` (por defecto `127.0.0.1`, solo tu máquina) y en
`PORT` (por defecto 4380). No cambies `HOST` para desarrollar con pnpm: en la
ruta B (Docker) la imagen y `docker-compose.yml` ya fijan `HOST=0.0.0.0`, porque
dentro del contenedor el proceso debe atender todas las interfaces; el puerto
sigue publicado solo en `127.0.0.1` del anfitrión.

### Límite de intentos de login (desarrollo)

El backend limita `POST /api/v1/auth/login` en memoria, solo por credenciales
**fallidas**: por IP (5 intentos cada 15 minutos, ventana fija) y por RUT (5
intentos y luego un bloqueo **progresivo**: 1 minuto, 2, 4, 8… hasta la ventana;
un login correcto reinicia el nivel). El intento se reserva antes de verificar
la contraseña, así que ráfagas paralelas tampoco superan el máximo. Variables
opcionales, leídas una sola vez al arrancar:

- `AUTH_RATE_LIMIT_DISABLED=true`: desactiva el límite (solo desarrollo; el
  backend se niega a arrancar con `NODE_ENV=production`).
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`: entero positivo de intentos por ventana.
- `AUTH_RATE_LIMIT_WINDOW_MS`: entero positivo, duración de la ventana en ms.
- `AUTH_TRUST_PROXY_HOPS`: entero no negativo, cuántos proxies inversos
  confiables hay delante del backend (ver abajo). Vacío o sin definir: no se
  confía en ningún proxy.

```sh
AUTH_RATE_LIMIT_DISABLED=true pnpm dev
```

Valores inválidos de `MAX_ATTEMPTS`, `WINDOW_MS` y `AUTH_TRUST_PROXY_HOPS`
detienen el arranque con un error claro. `AUTH_RATE_LIMIT_DISABLED` acepta
`true`, `false` o vacío (sin distinguir mayúsculas ni espacios); cualquier otro
valor detiene el arranque. Estas variables se leen en el proceso del backend
(`pnpm dev`, ruta A). En la ruta B (Docker) el `docker-compose.yml` base solo
fija `AUTH_TRUST_PROXY_HOPS=1`; las demás variables no se reenvían al
contenedor. El limitador vive en memoria: se
reinicia al reiniciar el backend.

**Detrás de un proxy (`AUTH_TRUST_PROXY_HOPS`).** Con `pnpm dev` el proxy de
Vite también reenvía `X-Forwarded-For`, pero el backend lo ignora por defecto y
ve la IP del proxy: todos los clientes comparten la clave de IP. En la ruta B
(nginx del frontend → backend) el compose base fija `AUTH_TRUST_PROXY_HOPS=1`
porque nginx es el único proxy. El puerto del backend se publica solo en
loopback (lo necesitan `/health/*` y los checks de esta guía), pero un proceso
local que lo llame directamente puede falsificar `X-Forwarded-For` y esquivar la
clave de IP; la clave por RUT sigue aplicando. Es un riesgo residual aceptado
solo para desarrollo local. Pon el número exacto de proxies que controlas: un valor mayor al real
permite falsificar la IP con `X-Forwarded-For`, y uno menor deja la IP del
proxy. No lo uses si el backend es alcanzable sin pasar por el proxy.

`pnpm dev` arranca backend y frontend en paralelo. Para separarlos, usa
`pnpm --filter @invoiceops/backend dev` y `pnpm --filter @invoiceops/frontend dev`
en terminales distintas.

## 5B. Arrancar todo en Docker

```sh
docker compose -p invoiceops-dev --env-file .env \
  -f docker-compose.yml -f compose.invoiceops-local.yml up --build -d --wait
```

- Frontend: http://127.0.0.1:5174
- Backend: http://127.0.0.1:5300/health/ready

El overlay `compose.invoiceops-local.yml` fija `NODE_ENV=development`, así que la
cookie de sesión no exige HTTPS. Sin el overlay (solo `docker-compose.yml`) el
backend corre en `production`, la base no publica puerto y no podrás migrar
desde el host.

## 6. Comprobaciones

| Qué            | Cómo                                                              | Resultado esperado                                                           |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Backend vivo   | `curl -fsS <backend>/health/live`                                 | `{"status":"ok"}`                                                            |
| Base accesible | `curl -fsS <backend>/health/ready`                                | HTTP 200                                                                     |
| Login          | Abre el frontend e inicia sesión con `11111111-1` y tu contraseña | Se abre la app                                                               |
| Plataforma     | **Mi perfil** muestra la insignia de administrador de plataforma  | **Organizaciones** ofrece «Crear organización»                               |
| Organizaciones | En `/organizations/new`, crea una con el RUT de su primer ADMIN   | Aparece en **Organizaciones** tras refrescar                                 |
| Usuarios       | Como ADMIN, en `/organizations/:id/members/new` crea un usuario   | Contraseña temporal visible una sola vez (o la definida por ti, no mostrada) |
| Grupos         | En **Grupos** crea un grupo y luego agrega miembros con permisos  | Grupo y permisos persisten al recargar                                       |
| Facturas       | Abre **Facturas**                                                 | Bandeja vacía: el alta llega en RP0-09/RP0-14                                |

## Tests

```sh
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build
env -u DATABASE_URL -u TEST_DATABASE_URL pnpm test:integration   # PostgreSQL efímero propio
pnpm test:recovery:unit # guardas del reset y arranque sin ML/blockchain
pnpm test:recovery:ui   # onboarding, organizaciones, grupos, usuarios y membresías (frontend)
```

`pnpm test:integration` no usa la base de esta guía y se niega a correr si `DATABASE_URL` o `TEST_DATABASE_URL` están definidas en la shell; por eso se ejecuta con `env -u`.

Pruebas contra PostgreSQL real (esquema consolidado). Usan una base distinta,
`invoiceops_recovery_test`, que el runner **recrea en cada ejecución**; sin
`RECOVERY_TEST_DATABASE_URL` fallan (no se omiten):

```sh
set -a; . ./.env; set +a
export RECOVERY_TEST_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${LOCAL_APP_DB_PORT}/invoiceops_recovery_test?schema=public"
pnpm test:recovery:postgres
```

### Pruebas E2E del navegador (Playwright)

El paquete `apps/e2e` levanta la pila real (backend + Vite) contra la base aislada
`invoiceops_recovery_test`, que **recrea, migra y siembra en cada ejecución**
(personas, organizaciones, grupos y facturas deterministas). Nunca toca `invoiceops`.
Usa los puertos 4391 (backend) y 5391 (frontend), distintos de los de desarrollo.
`E2E_BACKEND_PORT` y `E2E_FRONTEND_PORT` pueden cambiarse, pero la suite **se niega
a arrancar** con un puerto de desarrollo: 4380, 5380, los de Docker (3000, 5173,
5300, 5174) o cualquiera que tu `.env`/shell configure (`PORT`, `BACKEND_PORT`,
`FRONTEND_PORT`, `LOCAL_BACKEND_PORT`, `LOCAL_FRONTEND_PORT`). Si `LOCAL_APP_DB_PORT`
está definido, la URL de la base de pruebas debe usar ese puerto. Antes de
cualquier prueba, `globalSetup` comprueba que lo que responde en esos puertos es la
pila de la suite: el administrador de plataforma sembrado debe iniciar sesión con la
contraseña de las pruebas y ver las organizaciones sembradas (así falla con un
servidor reutilizado que no sea el de la suite). El backend de la suite escucha solo
en `127.0.0.1` (`HOST`).

Antes de la primera ejecución:

```sh
pnpm install                                     # dependencias de todos los paquetes, incluido @invoiceops/e2e
pnpm --filter @invoiceops/e2e install:browsers   # una sola vez (solo chromium)
# Linux (CI o máquina nueva): agrega las librerías del sistema que necesita chromium
pnpm --filter @invoiceops/e2e install:browsers -- --with-deps
```

```sh
set -a; . ./.env; set +a   # POSTGRES_* y LOCAL_APP_DB_PORT; o define RECOVERY_TEST_DATABASE_URL
pnpm test:e2e              # escritorio 1440x900, móvil 375x812 y escritorio oscuro
```

Qué debes saber antes de correrlas:

- **No las ejecutes a la vez que `pnpm test:recovery:postgres`**: ambas
  **recrean la misma base** `invoiceops_recovery_test`; una borraría los datos de
  la otra a mitad de la ejecución y fallaría de forma aparentemente aleatoria.
  Corre una, espera a que termine y luego la otra.
- **Tardan unos 3 minutos** (102 pruebas; medido en esta máquina): recrean y siembran la base, arrancan dos servidores y
  corren todos los specs en los tres proyectos (escritorio, móvil y escritorio
  oscuro) con 3 trabajadores (`E2E_WORKERS`). Reintentos: ninguno (un fallo es un
  fallo).
- `E2E_REUSE_SERVERS=1` reutiliza servidores ya levantados, pero **solo sirve
  para servidores iniciados con `pnpm --filter @invoiceops/backend e2e:server`**
  (el que recrea y siembra la base de la suite) y el Vite de la suite en el puerto 5391. No lo uses con tu `pnpm dev`: apuntaría a la base de desarrollo y a
  otros puertos, y sin la siembra las pruebas fallarían o dejarían datos.
  Con servidores reutilizados la base **no se recrea**: reinicia el servidor de
  la suite para volver a un estado limpio. Se pueden encadenar ejecuciones sobre
  los mismos servidores: los RUT que crean las pruebas llevan un bloque por
  ejecución (`E2E_RUN_SLOT`, derivado del reloj en `globalSetup`, más el
  trabajador y un contador), así que una segunda ejecución no choca (`409`) con
  las personas de la primera. Dos ejecuciones simultáneas sobre la misma base no
  están soportadas, y los bloques se reutilizan tras unas 33 horas.
- Las capturas de página completa quedan en `apps/e2e/e2e-artifacts/<proyecto>/`
  (ignoradas por git; se vacía la carpeta al empezar cada ejecución) para
  revisarlas a ojo; los trazos de fallos, en `apps/e2e/test-results/`. **Los
  artefactos pueden contener credenciales de prueba** (la contraseña compartida de
  la base aislada y, en los trazos, cuerpos de solicitudes). La contraseña temporal
  del diálogo del asistente de usuario se enmascara en su captura deliberada, pero
  **no** se enmascaran las capturas ni los trazos de fallo de Playwright
  (`screenshot: "only-on-failure"` y `trace: "retain-on-failure"` en
  `playwright.config.ts`): no los publiques ni los adjuntes a tickets. Los specs que
  muestran una contraseña generada por el servidor (`admin-wizard.spec.ts` y
  `member-creation-secret.spec.ts`) desactivan la captura y la traza de fallo
  (`test.use({ screenshot: "off", trace: "off" })`, que Playwright solo permite a nivel
  de archivo); un fallo ahí deja menos evidencia a cambio de no guardar el secreto.
- La administración de plataforma está sembrada como USER, sin permisos ni grupos,
  en una única organización (`Gamma Plataforma`): las pantallas de organización parten
  de las membresías de la persona y los specs que necesitan a la plataforma dentro
  de una organización la leen en vez de agregarla a las suyas (los datos sembrados
  son de solo lectura).

## Pasar de Docker (5B) a desarrollo (5A)

Las imágenes de 5B son de producción (`dist/` compilado y build de Vite en nginx):
no recargan cambios. Para ajustar código conserva la base y detén solo backend y
frontend:

```sh
docker compose -p invoiceops-dev --env-file .env \
  -f docker-compose.yml -f compose.invoiceops-local.yml stop backend frontend
pnpm dev
```

Carga antes el paso 1 si la shell es nueva. Si cambias el esquema Prisma,
ejecuta `pnpm generate` y migra antes de probar. Para volver a 5B, detén
`pnpm dev` y repite el comando de 5B.

## Parar y reiniciar

```sh
# Detener conservando datos
docker compose -p invoiceops-dev --env-file .env \
  -f docker-compose.yml -f compose.invoiceops-local.yml down
```

### Reiniciar desde cero

Para recrear solo la base de la app, repite `pnpm recovery:local:reset -- --confirm-reset=invoiceops`
(paso 3). Borra todos los datos de `invoiceops`; no lo ejecutes si quieres conservarlos.
Comprueba antes el destino con `printf '%s\n' "${DATABASE_URL#*@}"` (debe mostrar
`127.0.0.1:$LOCAL_APP_DB_PORT/invoiceops...`, sin credenciales). Para borrar además el servidor, elimina **solo** los volúmenes del
proyecto `invoiceops-dev` (datos de esta guía):

```sh
docker compose -p invoiceops-dev --env-file .env \
  -f docker-compose.yml -f compose.invoiceops-local.yml down -v
```

Después repite los pasos 3 y 4.

## Problemas frecuentes

| Síntoma                                     | Causa probable                                                                                             | Solución                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL must be configured`           | No cargaste el paso 1 en esa terminal                                                                      | Repite el bloque `set -a` y `export DATABASE_URL`                                                                               |
| `port is already allocated`                 | Otro servicio usa el puerto                                                                                | Cambia `LOCAL_*_PORT` en `.env`                                                                                                 |
| Login devuelve 401                          | RUT o contraseña distintos, usuario sin contraseña o contraseña temporal vencida (24 h)                    | Revisa el paso 4; si la temporal venció, repite el reset y el bootstrap                                                         |
| Mutaciones devuelven 403 `FORBIDDEN_ORIGIN` | El navegador no envía un `Origin` igual al host                                                            | Entra por la URL del frontend, no por el backend directo                                                                        |
| `/health/ready` falla                       | Base detenida o sin crear con el reset                                                                     | Repite el paso 3                                                                                                                |
| Login devuelve 429 `RATE_LIMITED`           | Superaste el límite de intentos fallidos por IP (5 cada 15 min) o por RUT (bloqueo progresivo desde 1 min) | Espera el bloqueo (hasta 15 min), reinicia el backend, o usa `AUTH_RATE_LIMIT_DISABLED=true pnpm dev` (solo desarrollo, ruta A) |
| `Recovery reset refused`                    | Falló una guarda (host, nombre o confirmación)                                                             | Revisa `DATABASE_URL` y `--confirm-reset=<nombre>`                                                                              |
