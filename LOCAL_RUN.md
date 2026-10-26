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

> Estado provisional: la app aún no tiene un comando para crear el primer
> usuario con contraseña. El paso 4 usa el provisioner interno hasta que
> RP0-03 entregue `pnpm recovery:bootstrap`. Desde RP0-01 el esquema es una
> única migración consolidada en la base de desarrollo `invoiceops`;
> una base creada con las migraciones históricas no es compatible y debe
> recrearse con el reset del paso 3.

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

Crea un usuario con contraseña. `read -s` evita que la contraseña quede en el
historial o en la lista de procesos como argumento. El RUT debe ser válido
(`11111111-1` lo es).

```zsh
read -rs "NEW_PASSWORD?Contraseña del primer usuario: "; echo
export NEW_PASSWORD
USER_ID=$(pnpm --filter @invoiceops/backend exec tsx -e '
(async () => {
  const { createDatabase } = await import("./src/database.ts");
  const { provisionInternalUser } = await import("./src/internal-user-provisioning.ts");
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    const user = await provisionInternalUser(db.prisma, {
      name: "Administrador local",
      rut: "11111111-1",
      password: process.env.NEW_PASSWORD,
    });
    console.log(user.id);
  } finally {
    await db.prisma.$disconnect();
  }
})();' | tail -n 1)
unset NEW_PASSWORD
echo "userId: $USER_ID"
```

Los bloques usan sintaxis zsh. En bash, reemplaza la primera línea por
`read -rsp "Contraseña del primer usuario: " NEW_PASSWORD; echo`.

El comando imprime el `userId`, que queda en `USER_ID`. Si está vacío, detente:
el alta falló. Desígnalo administrador de plataforma (una sola vez por base):

```zsh
if [ -n "$USER_ID" ]; then pnpm --filter @invoiceops/backend platform-administrator bootstrap "$USER_ID" --confirm-bootstrap; else echo "Detente: no se obtuvo USER_ID" >&2; fi
```

Si el RUT ya existe, el alta falla por unicidad: usa ese usuario o reinicia la
base. El usuario no queda con cambio de contraseña obligatorio.

## 5A. Arrancar con pnpm (desarrollo)

Con `DATABASE_URL` cargada (paso 1):

```sh
pnpm dev
```

- Frontend: http://127.0.0.1:5380 (Vite reenvía `/auth`, `/profile`, `/groups`,
  `/invoices`, `/organizations`, `/business-policies` y `/platform` al backend).
- Backend: http://127.0.0.1:4380/health/ready

### Límite de intentos de login (desarrollo)

El backend limita `POST /auth/login` por IP (por defecto 5 intentos cada 15
minutos, en memoria). Variables opcionales, leídas una sola vez al arrancar:

- `AUTH_RATE_LIMIT_DISABLED=true`: desactiva el límite (solo desarrollo; el
  backend se niega a arrancar con `NODE_ENV=production`).
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`: entero positivo de intentos por ventana.
- `AUTH_RATE_LIMIT_WINDOW_MS`: entero positivo, duración de la ventana en ms.

```sh
AUTH_RATE_LIMIT_DISABLED=true pnpm dev
```

Valores inválidos de `MAX_ATTEMPTS` y `WINDOW_MS` detienen el arranque con un
error claro. En `AUTH_RATE_LIMIT_DISABLED` solo el valor literal `true` (sin
distinguir mayúsculas) desactiva el límite; cualquier otro valor se ignora y el
límite sigue activo. Estas variables se leen en el proceso del backend (`pnpm dev`,
ruta A); el overlay de Docker (ruta B) no las reenvía al contenedor. El limitador
vive en memoria: se reinicia al reiniciar el backend.

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

| Qué            | Cómo                                                              | Resultado esperado                            |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| Backend vivo   | `curl -fsS <backend>/health/live`                                 | `{"status":"ok"}`                             |
| Base accesible | `curl -fsS <backend>/health/ready`                                | HTTP 200                                      |
| Login          | Abre el frontend e inicia sesión con `11111111-1` y tu contraseña | Se abre la app                                |
| Plataforma     | **Mi perfil** muestra la insignia de administrador de plataforma  | Aparece **Administración**                    |
| Administración | Crea una organización y aprovisiona un usuario                    | Ambos aparecen tras refrescar                 |
| Grupos         | Crea un grupo en esa organización y agrega integrantes            | El grupo aparece en **Mis grupos**            |
| Facturas       | Abre **Facturas**                                                 | Bandeja vacía: el alta llega en RP0-09/RP0-14 |

## Tests

```sh
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build
env -u DATABASE_URL -u TEST_DATABASE_URL pnpm test:integration   # PostgreSQL efímero propio
pnpm test:recovery:unit # guardas del reset y arranque sin ML/blockchain
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

| Síntoma                                  | Causa probable                                         | Solución                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL must be configured`        | No cargaste el paso 1 en esa terminal                  | Repite el bloque `set -a` y `export DATABASE_URL`                                                            |
| `port is already allocated`              | Otro servicio usa el puerto                            | Cambia `LOCAL_*_PORT` en `.env`                                                                              |
| Login devuelve 401                       | RUT o contraseña distintos, o usuario sin contraseña   | Revisa el paso 4                                                                                             |
| Mutaciones devuelven 403 `Forbidden`     | El navegador no envía un `Origin` igual al host        | Entra por la URL del frontend, no por el backend directo                                                     |
| `/health/ready` falla                    | Base detenida o sin crear con el reset                 | Repite el paso 3                                                                                             |
| Login devuelve 429 `Demasiados intentos` | Superaste el límite de intentos por IP (5 cada 15 min) | Espera 15 min, reinicia el backend, o usa `AUTH_RATE_LIMIT_DISABLED=true pnpm dev` (solo desarrollo, ruta A) |
| `Recovery reset refused`                 | Falló una guarda (host, nombre o confirmación)         | Revisa `DATABASE_URL` y `--confirm-reset=<nombre>`                                                           |
