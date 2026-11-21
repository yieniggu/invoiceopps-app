# Despliegue en producción

Un solo host Docker (linux/amd64) detrás de un túnel Cloudflare. El stack
(`compose.production.yml`, proyecto `invoiceops`) **no publica ningún puerto**:
la única entrada es `invoiceops-web:80`, visible solo en la red externa
`aglai_edge`, donde vive el contenedor `cloudflared` del túnel `aglai-home-server`.
Rutas de datos: `db` (red interna `invoiceops_db`) y `backend` (red `invoiceops_api`)
no son alcanzables desde `aglai_edge`.

Todos los comandos se ejecutan en el servidor, en `/opt/invoiceops/app`.

> **Stack unificado.** Con MLflow, el gateway y la Model API el servidor se opera desde
> `invoiceops-stack` (`/opt/invoiceops/stack`): su `compose.yml` hace `include:` de este
> `compose.production.yml` y mantiene el proyecto `invoiceops`, el volumen
> `invoiceops_postgres_data` y las redes. Un solo comando levanta todo:
> `docker compose --env-file /opt/invoiceops/invoiceops.env up -d`. Los comandos de abajo
> (`-f compose.production.yml`) siguen siendo válidos para la app sola, pero **no mezcle** ambos
> modos sobre el mismo proyecto. Migración: «Migración desde el proyecto actual de la app» en
> `dev/tickets/MLOPS-07_plan.md`.

## 1. Prerrequisitos

```bash
docker --version && docker compose version
curl --version && python3 --version                      # los usa ops/smoke.sh (no necesita Node)
docker network inspect aglai_edge --format '{{.Name}}'   # debe existir
```

Las credenciales de la base de datos quedan visibles con `docker inspect` para
cualquier usuario del grupo `docker`: mantén ese grupo restringido a operadores.

## 2. Código

```bash
sudo mkdir -p /opt/invoiceops && sudo chown "$USER" /opt/invoiceops
git clone https://github.com/yieniggu/invoiceopps-app.git /opt/invoiceops/app
cd /opt/invoiceops/app
git checkout <commit>
```

## 3. Secretos (fuera del repositorio)

```bash
cp ops/production.env.example /opt/invoiceops/invoiceops.env
chmod 600 /opt/invoiceops/invoiceops.env
openssl rand -hex 32   # pegar como POSTGRES_PASSWORD (debe ser URL-safe)
openssl rand -hex 32   # pegar como POSTGRES_APP_PASSWORD (otra clave distinta)
```

Edita `/opt/invoiceops/invoiceops.env`: `POSTGRES_PASSWORD` (dueño de la base, solo
lo usan las migraciones), `POSTGRES_APP_USER` (`invoiceops_app`), `POSTGRES_APP_PASSWORD`
(rol sin privilegios con el que se conectan `backend` y `bootstrap`), `PUBLIC_ORIGIN`
(`https://invoiceops.aglai.dev`) e `INVOICEOPS_VERSION` (p. ej. `git rev-parse --short HEAD`).
Sin `POSTGRES_PASSWORD` o `POSTGRES_APP_PASSWORD` compose se niega a arrancar. Usa siempre
`--env-file` explícito, como abajo.

**Las claves de la base solo se aplican en el primer arranque.** El rol
`POSTGRES_APP_USER` lo crea `ops/postgres/initdb/10-app-role.sh` únicamente cuando
`db` arranca con el volumen vacío. Cambiar después `POSTGRES_PASSWORD` o
`POSTGRES_APP_PASSWORD` en el archivo de entorno **no** cambia la clave dentro de
PostgreSQL y el backend dejaría de conectarse. Rotarlas es una operación manual
(`ALTER ROLE ...` dentro de `db`) y no forma parte de este procedimiento.

## 4. Build, base de datos, migraciones, administrador

```bash
cd /opt/invoiceops/app
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml build
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml --profile ops build migrate
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml up -d db
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml run --rm migrate
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml run --rm bootstrap
```

`migrate` usa el dueño de la base; `bootstrap` y el backend usan el rol `invoiceops_app`
(sin superusuario ni permiso para crear/borrar tablas).

`bootstrap` es interactivo (nombre, RUT y contraseña temporal dos veces; la
temporal vence en 24 h y obliga a cambiarla al primer login). Se ejecuta una vez.

**Entra antes de 24 h.** Si la temporal vence, volver a ejecutar `bootstrap` con el
mismo RUT responde `unchanged` y no la renueva, y no hay otro administrador que pueda
restablecerla desde la aplicación. Recuperación mínima (RUT sin puntos ni guion, p. ej.
`123456785`; debe devolver `UPDATE 1`):

```bash
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v rut="$0" -f -' <RUT-SIN-PUNTOS-NI-GUION> <<'SQL'
UPDATE "User" SET "temporaryPasswordExpiresAt" = now() + interval '24 hours'
WHERE rut = :'rut' AND "mustChangePassword" = true;
SQL
```

Luego entra con la misma contraseña temporal dentro de las siguientes 24 h.

## 5. Arranque y verificación

```bash
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml up -d
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml ps   # db, backend, web: healthy
docker network inspect aglai_edge --format '{{range .Containers}}{{.Name}} {{end}}'    # incluye invoiceops-web-1 y cloudflared
```

## 6. Cloudflare (manual)

En Zero Trust, túnel `aglai-home-server` → Public hostname:
`invoiceops.aglai.dev` → servicio `http://invoiceops-web:80`.
El contenedor `cloudflared` debe estar conectado a `aglai_edge`.

## 7. Smoke test

Con la contraseña **definitiva** del administrador (tras el cambio obligatorio):

```bash
BASE_URL=https://invoiceops.aglai.dev ops/smoke.sh <RUT>
```

Pide la contraseña sin eco (o usa `SMOKE_PASSWORD`; en ambos casos no pasa por argv);
no crea datos. Comprueba también las cabeceras de seguridad. Debe terminar en `SMOKE OK`.
Solo necesita `bash`, `curl` y `python3`, y puede ejecutarse igual desde tu máquina,
fuera de la LAN, porque usa la URL pública.

## 8. Actualizar

```bash
cd /opt/invoiceops/app
git fetch && git checkout <commit>
# actualiza INVOICEOPS_VERSION en /opt/invoiceops/invoiceops.env
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml build
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml --profile ops build migrate
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml run --rm migrate
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml up -d
BASE_URL=https://invoiceops.aglai.dev ops/smoke.sh <RUT>
```

Ejecuta siempre `up -d` **sin nombres de servicio ni `--no-deps`**: nginx (`web`) resuelve
`invoiceops-backend` una sola vez al arrancar, y solo un `up -d` completo reinicia `web`
cuando el backend se recrea (`depends_on.restart`). Recrear solo el backend puede dejar a
`web` apuntando a una IP vieja (502).

## 9. Volver a la versión anterior

Las imágenes anteriores siguen en el host (etiquetadas por `INVOICEOPS_VERSION`). Para volver:
pon la `INVOICEOPS_VERSION` previa en `/opt/invoiceops/invoiceops.env`, haz
`git checkout <commit-previo>` y ejecuta

```bash
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml up -d
```

Solo es válido si la actualización **no** aplicó una migración incompatible con la versión
anterior (no hay respaldos de la base en este procedimiento: no se puede deshacer una
migración). No ensayado en el arnés local.

**Paso previo si vuelves a una versión anterior a la migración `20261101000000_api_token_mlflow_scopes`
(CR-521).** Ese comentario de la migración («volver atrás es seguro») es incorrecto para los datos: PostgreSQL no
puede quitar los valores `mlflow:read` y `mlflow:write` del enum, y la versión anterior falla con `P2023` al leer
cualquier fila de `ApiToken` que los contenga (también las revocadas o vencidas). Antes de levantar la versión
anterior, con el rol dueño (`POSTGRES_USER`, no el rol de la aplicación), elimina esos tokens. Avisa antes a las
personas que los usan: dejarán de funcionar, incluidos los tokens que además tenían scopes de facturas, y deberán
volver a emitirlos al actualizar de nuevo. Revocarlos no basta, porque la fila se sigue leyendo:

```bash
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -' <<'SQL'
BEGIN;
SELECT count(*) AS mlflow_tokens FROM "ApiToken" WHERE "scopes" && ARRAY['mlflow:read', 'mlflow:write']::"ApiTokenScope"[];
DELETE FROM "ApiToken" WHERE "scopes" && ARRAY['mlflow:read', 'mlflow:write']::"ApiTokenScope"[];
COMMIT;
SQL
```

## 10. Detener, reiniciar y borrar

Parada y reinicio normales: `docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml down` / `docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml up -d` (sin `-v`; el volumen se conserva).

**`down -v` (o `docker volume rm invoiceops_postgres_data`) destruye la base de datos de
forma irreversible.** No lo uses salvo que quieras empezar de cero (el siguiente arranque
volvería a crear los roles y exigiría migrar y ejecutar `bootstrap` otra vez).

Al detener, el backend deja de aceptar conexiones, aborta las llamadas en curso a la Model API (worker de
predicciones y tarea de mantenimiento de modelos), devuelve los jobs reclamados y cierra el pool de la base. Su
plazo máximo propio es `SHUTDOWN_DEADLINE_MS` (10 s, `apps/backend/src/server.ts`). `compose.production.yml` fija
`stop_grace_period: 20s` en `backend` para que Docker no envíe `SIGKILL` antes de ese plazo; si subes
`SHUTDOWN_DEADLINE_MS`, sube también `stop_grace_period`.

## 11. Logs

```bash
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml logs -f --tail=100 backend web db
```

## 12. Alertas sobre la cola de predicciones

El backend no expone métricas Prometheus: las alertas se basan en las líneas JSON que escribe en stdout
(una por línea, visibles con `docker compose ... logs backend`). Cada línea tiene `time`, `level` y `event`
más los campos del evento; nunca incluye cuerpos, RUT ni secretos.

Evento `prediction.failed_spike` (nivel `warn`), se emite cada `PREDICTION_METRICS_INTERVAL_MS` (60 s) mientras
los jobs `FAILED` de la ventana alcancen `PREDICTION_FAILED_WARN_THRESHOLD` (10 por defecto):

```json
{
  "time": "2026-11-20T12:00:00.000Z",
  "level": "warn",
  "event": "prediction.failed_spike",
  "feature": "predictions",
  "failedInWindow": 14,
  "windowSeconds": 900,
  "threshold": 10
}
```

Evento `prediction.queue` (nivel `info`), una línea por intervalo. `oldestPendingAgeSeconds` es la edad en
segundos del job `PENDING` más antiguo y **no aparece** cuando no hay jobs pendientes:

```json
{
  "time": "2026-11-20T12:00:00.000Z",
  "level": "info",
  "event": "prediction.queue",
  "feature": "predictions",
  "pendingCount": 42,
  "failedInWindow": 0,
  "oldestPendingAgeSeconds": 780
}
```

Alertas recomendadas:

| Alerta            | Condición                                                               | Severidad | Qué indica                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Pico de fallos    | al menos una línea con `event = "prediction.failed_spike"` en 10 min    | alta      | Los jobs fallan (Model API caída, modelo rechazado, entrada inválida). Mira `lastErrorCode` con la consulta del README.    |
| Cola que envejece | `oldestPendingAgeSeconds > 600` en 3 líneas `prediction.queue` seguidas | media     | El worker no avanza: Model API caída (el backoff llega a 15 min), worker apagado o `PREDICTION_WORKER_DISABLED=true`.      |
| Cola atascada     | `oldestPendingAgeSeconds > 3600`                                        | alta      | Casi seguro hay un problema sostenido; a las 24 h (`PREDICTION_MAX_JOB_AGE_MS`) los jobs pasan a `FAILED` (`JOB_EXPIRED`). |
| Sin señal         | ninguna línea `prediction.queue` en 3 intervalos (3 min)                | alta      | El backend está caído o la tarea de métricas no corre.                                                                     |

Una cola sana muestra `oldestPendingAgeSeconds` de pocos segundos o ausente. Un valor puntual alto que baja en la
línea siguiente no es una alerta: exige varias líneas seguidas.

Consulta manual desde el servidor (`jq` en modo `-R` ignora las líneas que no son JSON, como la de arranque):

```bash
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml logs --no-log-prefix --since 15m backend | jq -R -c 'fromjson? | select(.event == "prediction.failed_spike")'
```

```bash
docker compose --env-file /opt/invoiceops/invoiceops.env -f compose.production.yml logs --no-log-prefix --since 15m backend | jq -R -c 'fromjson? | select(.event == "prediction.queue" and (.oldestPendingAgeSeconds // 0) > 600) | {time, pendingCount, oldestPendingAgeSeconds}'
```

En un agregador de logs (ejemplo en LogQL de Loki; ajusta el selector de contenedor al tuyo):

```logql
sum(count_over_time({container="invoiceops-backend-1"} | json | event="prediction.failed_spike" [10m])) > 0
```

```logql
min_over_time({container="invoiceops-backend-1"} | json | event="prediction.queue" | unwrap oldestPendingAgeSeconds [3m]) > 600
```

Regla «Sin señal» (ninguna línea `prediction.queue` en 3 intervalos). Una comparación como `count_over_time(...) < 1`
no sirve: cuando no hay líneas no existe ninguna serie y la consulta no devuelve nada, así que la alerta nunca
dispara. Usa `absent_over_time`, que devuelve `1` justamente cuando no hubo ninguna línea en la ventana (ajusta el
selector de contenedor al tuyo y evalúa la regla al menos cada minuto):

```logql
absent_over_time({container="invoiceops-backend-1"} | json | event="prediction.queue" [3m])
```

La regla de «Cola que envejece» toma el **mínimo** de la ventana de 3 minutos: solo dispara si las tres líneas superan 600 s.
Con `unwrap` las líneas sin `oldestPendingAgeSeconds` (cola vacía) se descartan.

Otro evento a vigilar: `prediction.unkeyed_priors_capped` (`warn`, con `invoiceId`, `organizationId` y
`threshold`) indica que el respaldo para facturas sin `supplierKey` llegó a su tope de 5000 filas y las
previas de esa predicción pueden estar incompletas hasta que termine el backfill (ver README). Se emite como máximo una vez cada 10 minutos por organización y ámbito.

Evento `models.reconcile_unavailable` (`warn`, con `feature` y `sweptCount`): el reconciliador de modelos no pudo
consultar la Model API y omitió la pasada (no descarga ni recarga nada hasta que vuelva). Se emite como máximo una
vez cada 5 minutos por proceso, así que una línea indica una caída en curso y la ausencia de líneas, que se recuperó.
Alerta recomendada (severidad media): al menos una línea en 10 min.

```logql
sum(count_over_time({container="invoiceops-backend-1"} | json | event="models.reconcile_unavailable" [10m])) > 0
```

## Solo verificable en el servidor real

- Que `aglai_edge` exista y `cloudflared` esté en ella; la ruta pública del túnel.
- Que `cloudflared`/Cloudflare entreguen `CF-Connecting-IP` con la IP real del cliente
  (límite de intentos por usuario real) y HTTPS con `Origin` `https://invoiceops.aglai.dev`.
- Que ningún otro contenedor de `aglai_edge` use los nombres `invoiceops-web` o `invoiceops-backend`.
- Arquitectura amd64 del host y recursos reales (RAM/CPU del build).
- Riesgo residual **aceptado** (2026-10-30, ticket `DEP-04_edge_client_ip_trust`): nginx
  confía en `CF-Connecting-IP` desde rangos privados; un contenedor del operador en
  `aglai_edge` podría falsificarlo y eludir el límite de intentos por IP. Internet no puede.

## Prueba local equivalente

`bash ops/prodlike/run.sh` levanta este mismo stack con un edge simulado (TLS
autofirmado en `https://localhost:8443`) y un contenedor hostil; `--down` lo elimina.
