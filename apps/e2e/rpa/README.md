# Bot RPA de referencia: creación de facturas en lote

Bot de Playwright que lee un Excel, inicia sesión y crea cada fila como factura.
Decide **solo** con el contrato de selectores
([`docs/rpa-selector-contract.md`](../../../docs/rpa-selector-contract.md)):
`data-testid`, `#id`, atributos `data-*`, `name` y `value` de las opciones. Nunca
lee el texto en español ni clases CSS. La única comparación de texto es el
nombre de la organización/grupo del Excel contra el `<optgroup label>` /
`<option>` del selector de alcance (es un dato, no copy de la interfaz).

- `contract.ts`: el mapa de selectores.
- `excel.ts`: lectura del Excel de entrada y escritura del de salida.
- `matching.ts`: decisiones puras (alcance, comparación factura/fila, redacción).
- `args.ts`: argumentos del CLI y validación de `--base-url` y rutas.
- `run-support.ts`: códigos de salida y volcado de resultados (`.results.json`).
- `atomic.ts`: escritura atómica (archivo temporal y `rename`).
- `summary.ts`: resumen de la demo.
- `invoice-batch-bot.ts`: el bot.
- `run.ts`: CLI para correrlo fuera del test runner.
- `fixtures/`: `invoice-batch.xlsx` (plantilla con marcadores) y su generador
  (`pnpm --filter @invoiceops/e2e rpa:fixture`).

## Correr el spec

Desde la raíz del repo, con la base de datos de desarrollo arriba (el spec usa
su propia base e2e):

```sh
set -a; . ./.env; set +a; pnpm --filter @invoiceops/e2e exec playwright test tests/rpa-invoice-batch.spec.ts --project=desktop
```

El spec crea una organización y un usuario con permisos, copia la plantilla
reemplazando los marcadores, inyecta los fallos de la columna `fault` y comprueba
que cada fila termine en su `expected`. La plantilla versionada nunca se modifica.

## Correr el bot contra la app local

1. Levanta la app (`pnpm dev`, ver `LOCAL_RUN.md`; frontend en
   `http://127.0.0.1:5380`) y ten un usuario que pueda crear facturas.
2. Los marcadores `{{ORG}}`, `{{GROUP}}`, `{{UNKNOWN_GROUP}}` y `{{RUN}}` de la
   plantilla se reemplazan con `--set` (se escribe una copia temporal):

```sh
RPA_RUT=11111111-1 RPA_PASSWORD='...' pnpm --filter @invoiceops/e2e rpa:run -- \
  --input rpa/fixtures/invoice-batch.xlsx --output /tmp/resultado.xlsx \
  --set ORG='Mi organización' --set GROUP='Compras' \
  --set UNKNOWN_GROUP='No existe' --set RUN="LOTE-$(date +%s)" \
  [--base-url http://127.0.0.1:5380] [--headed]
```

El bot imprime la URL que usa y solo escribe credenciales en `localhost`,
`127.0.0.1` o `[::1]`. Para otro destino pasa `--allow-remote` (exige https; la
URL no puede traer usuario ni contraseña). `--output` no puede ser el mismo
archivo que `--input` (se comparan enlaces simbólicos, enlaces duros y, en macOS y
Windows, mayúsculas/minúsculas: `In.xlsx` y `in.xlsx` son el mismo archivo); su
carpeta se crea antes de abrir el navegador.

Códigos de salida:

- 0: lote terminado.
- 1: lote abortado o caído (también si la caída fue durante la reconciliación
  final), o resultados que no se pudieron escribir como Excel. El Excel de salida
  se escribe igual cuando es posible; si falla, los resultados se vuelcan en
  `<salida>.results.json` (o por stderr si eso también falla).
- 2: error de entrada (argumentos, columnas faltantes, `row_id` repetido,
  `--base-url` inválida, entrada inexistente): imprime el uso, no un stack.
- 129 / 130 / 143: se recibió SIGHUP / SIGINT (Ctrl-C) / SIGTERM. La señal
  manda sobre el estado del lote: incluso si todas las filas ya habían terminado
  el código es el de la señal (quien la envió pidió detener el proceso).

**Señales (Ctrl-C, SIGTERM, SIGHUP)**: el CLI detiene el lote de inmediato, sin
esperar la fila que se estaba enviando: esa fila queda `UNCERTAIN`
(`error_kind=interrupted`, la factura pudo crearse y no se reconcilia), las que
no empezaron quedan `NOT_PROCESSED`, y el Excel de salida se escribe con lo
terminado (basta con que el Excel de entrada se haya leído). Los manejadores de
señales propios de Playwright están desactivados (`launchOptions()` en
`run-support.ts`: `handleSIGINT/SIGTERM/SIGHUP: false`, con prueba unitaria) para
que no cierren el navegador ni terminen el proceso con 130 mientras se escribe la
salida. Una señal que llega antes de abrir el navegador deja todas las filas
`NOT_PROCESSED` y no abre nada. Si llega antes de que existan los manejadores
(arranque, antes de validar argumentos) el proceso muere con la acción por
defecto y no se escribe salida (no se envió nada). Los manejadores no se quitan
hasta que el proceso termina, así que una señal justo después del lote solo fija
el código (128+N). Una segunda señal sale sin escribir más, pero espera a que
termine una escritura atómica en curso y entonces sale con 128+N; una tercera
señal, o 10 s después de la segunda si la escritura no termina, fuerza la salida
(se borra el temporal en curso). Si la limpieza falla (p. ej. EBUSY/EPERM al
borrar un temporal), se avisa por stderr y la salida con 128+N ocurre igual.
Precedencia del código de salida: una señal
recibida (129 / 130 / 143) manda sobre un error de entrada (2), que manda sobre
cualquier otra caída (1) y sobre el resultado del lote; el manejador de la señal
fija el código, así que vale aunque llegue después de calcular el resultado o
mientras se lee el Excel de entrada.

**Escritura atómica**: el Excel se escribe en `<salida>.tmp-<pid>-<hex aleatorio>`
(misma carpeta, creado de forma exclusiva: un enlace simbólico plantado con ese
nombre no puede redirigir la escritura) y se renombra al final, así que una caída o una segunda señal a mitad
de la escritura nunca deja un Excel truncado: el archivo final es el anterior o
el nuevo completo. Lo mismo vale para `<salida>.results.json`. Si la salida es un
enlace simbólico se escribe a través del enlace (el enlace se conserva y se
actualiza su destino real; `--output` sigue sin poder apuntar a la entrada). En
Windows (mejor esfuerzo; el stack E2E apunta a macOS y Linux) el `rename` se
reintenta unas veces ante EPERM/EBUSY. Si el proceso muere con SIGKILL en medio,
puede quedar un `.tmp-<pid>-<hex>` suelto: se puede borrar (`*.results.json` y
`*.tmp-*` están en `apps/e2e/.gitignore`).

Justo antes del `rename` se vuelve a resolver la carpeta real (`realpath`) del
destino y la escritura falla si cambió desde que se eligió el destino. Es una
comprobación barata, no una defensa: un atacante local que intercambie un enlace
simbólico entre `resolveWriteTarget` y el `rename` queda fuera de alcance (CLI
local, carpetas del propio usuario).

Tras una señal, el lanzador del backend E2E la reenvía al servidor y, si este no
termina en 8 s (antes de los 10 s de Playwright), le envía SIGKILL. Si el servidor (o el proceso de semilla) no
puede lanzarse y emite `error`, el lanzador imprime una línea `[e2e-backend]` y
sale con 1 (128+N si ya estaba deteniéndose).

Si el lanzador del backend E2E (`e2e-backend.mjs`) muere con SIGKILL, el servidor
hijo termina solo; si un arranque posterior dice que el puerto está ocupado, el
mensaje incluye los PID (vía `lsof`, si existe) y el comando `kill` a usar. Ver el
runbook (`docs/rpa-runbook.md`, §6).

La prueba de proceso está en `tests/rpa-cli-signal.spec.ts`: lanza `rpa/run.ts`
contra el stack aislado, le envía SIGINT/SIGTERM a mitad del lote y comprueba el
código de salida (130/143), que el Excel existe y las clasificaciones por fila.

Un RUT o contraseña que la propia página rechaza (mensajes `#login-rut-error` /
`#login-password-error`) aborta el lote de inmediato con `error_kind=credentials`.

Con un Excel propio no hace falta `--set`. Las filas `fault` de la plantilla solo
tienen sentido bajo el spec: fuera de él se comportan como filas normales.

## Demo de clase

`pnpm demo:rpa` (con ventana) y `pnpm demo:rpa:headless` corren
`tests/rpa-demo.spec.ts` en el proyecto `demo` de Playwright, que **solo existe
con `RPA_DEMO=1`** (lo ponen esos scripts): `pnpm test:e2e` y el CI no lo corren.
`RPA_DEMO_HEADLESS` acepta `1`/`0`/`true`/`false` y `RPA_DEMO_SLOWMO` un entero
no negativo; cualquier otro valor es un error. Cada corrida deja
`apps/e2e/demo-output/<fecha>_<corrida>/` con `input.xlsx`, `output.xlsx`,
`final.png`, `video.webm`, `trace.zip` (grabado por el spec en esa carpeta, no se
sobrescribe) y `summary.md`/`summary.json`. El resumen compara cada factura
`CREATED*` con la de la API (monto, proveedor, fechas, alcance e id). Trace y
video contienen la contraseña de prueba: no los publiques.

## Reconciliación

El bot decide solo con los atributos `data-*` de la fila de la bandeja (monto,
proveedor, fechas y alcance; ver `docs/rpa-selector-contract.md`). No llama a la
API: la comparación con la API del resumen es verificación de la demo, no del
bot.

## Columnas

Entrada (fila de encabezado, snake_case). Solo las nueve primeras son
obligatorias; `expected`, `fault` y `note` son opcionales y se leen vacías si la
hoja no las trae. `row_id` no puede repetirse (el error nombra los ids).

| Columna         | Significado                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `row_id`        | identificador de la fila                                                |
| `organization`  | nombre de la organización                                               |
| `group`         | nombre del grupo; vacío = alcance de organización                       |
| `business_id`   | número de factura                                                       |
| `supplier_name` | proveedor                                                               |
| `amount_pesos`  | monto; número o texto, el texto se envía tal cual (`12.500`)            |
| `issued_on`     | emisión; fecha de Excel o texto, se normaliza a `yyyy-MM-dd`            |
| `due_on`        | vencimiento; igual que la emisión                                       |
| `status`        | `PENDING`, `APPROVED`, `REJECTED` o `CANCELLED`                         |
| `expected`      | solo para el test (`RESULTADO` o `RESULTADO:detalle`); el bot no lo lee |
| `fault`         | solo para el test (fallo que inyecta el arnés); el bot no lo lee        |
| `note`          | comentario libre                                                        |

Salida (las de entrada más estas):

| Columna        | Significado                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `result`       | `CREATED`, `CREATED_AFTER_RETRY`, `CREATED_RECONCILED`, `REJECTED_FIELD`, `REJECTED`, `SKIPPED`, `UNCERTAIN`, `MANUAL_REVIEW`, `NOT_PROCESSED` |
| `invoice_id`   | UUID de la factura creada                                                                                                                      |
| `error_kind`   | `field`, `rejected`, `uncertain`, `burned`, `scope`, `session`, `credentials`, `onboarding`, `forbidden`, `reconcile`, `crash`…                |
| `error_status` | código HTTP, vacío si no hubo respuesta                                                                                                        |
| `error_code`   | `error.code` de la API, `SCOPE_NOT_AVAILABLE`, `ORGANIZATION_AMBIGUOUS`, `STATUS_NOT_AVAILABLE` o `RECONCILE_MISMATCH`                         |
| `field`        | campo con error (`supplierName`, `amount`, `dueOn`, `businessId`…)                                                                             |
| `message`      | texto de la interfaz, solo para personas y logs                                                                                                |
| `attempts`     | envíos realizados (incluye reintentos)                                                                                                         |
| `finished_at`  | marca de tiempo ISO                                                                                                                            |

Códigos propios del bot:

- `ORGANIZATION_AMBIGUOUS` (`SKIPPED`): `organization` vacía y la cuenta ve más
  de una organización, o varias organizaciones ofrecidas comparten el nombre
  pedido; con una sola coincidencia se usa esa.
- `RECONCILE_MISMATCH` (`REJECTED` o `UNCERTAIN`): el número de factura ya existe
  pero monto, proveedor, fechas o alcance difieren de la fila (p. ej. una factura
  de una corrida anterior), o la fila no expone todos sus atributos `data-*` y no se puede confirmar; no se reporta
  `CREATED_RECONCILED`.
- `error_kind=crash`: un error inesperado (timeout, página cerrada) cortó el
  lote; las filas terminadas se conservan y `message` lleva el error sin
  credenciales. La fila **en vuelo** (ya se pulsó «Crear» y no tiene resultado)
  queda `UNCERTAIN`, porque la factura puede existir, y no se reconcilia; las
  siguientes, y una fila que cayó antes de pulsar «Crear», quedan
  `NOT_PROCESSED`.
- Fechas inexistentes (`31/02/2026`, `2026-02-31`) o series de Excel fuera de
  1990-2100: el campo se deja vacío y la interfaz rechaza solo esa fila
  (`REJECTED_FIELD`); el lote no se cae.

El bot **nunca** pulsa «Crear como operación nueva»: una clave de idempotencia
quemada termina en `MANUAL_REVIEW`.
