# Runbook RPA: lote de facturas desde Excel

Paso a paso para construir el bot en UiPath o Power Automate Desktop (PAD).
Cada paso dice qué ubicar, qué esperar y cómo decidir. Los valores salen del
[contrato de selectores](rpa-selector-contract.md); la referencia ejecutable es
el bot de Playwright en `apps/e2e/rpa/invoice-batch-bot.ts`.

## Demo en un comando

Para mostrar el bot en clase sin armar nada a mano: abre un navegador visible,
crea una organización de prueba, procesa el Excel `demo-batch.xlsx` (13 filas:
facturas válidas, una sin grupo, campos inválidos, un duplicado y un grupo
inexistente, sin fallas inyectadas), verifica en la API que cada factura creada existe y deja un
resumen.

Requisitos (una sola vez, desde la raíz del repo):

```sh
# 1. Postgres local arriba
docker compose -p invoiceops-dev --env-file .env -f docker-compose.yml -f compose.invoiceops-local.yml up -d --wait db
# 2. Chromium de Playwright
pnpm --filter @invoiceops/e2e install:browsers
```

Correr la demo (carga `.env` sola; levanta el backend en 4391 y el frontend en
5391, y recrea la base aislada `invoiceops_recovery_e2e`, nunca la de
desarrollo):

```sh
pnpm demo:rpa              # con ventana, en cámara lenta
pnpm demo:rpa:headless     # sin ventana (sin pantalla)
```

- La demo es opcional: el proyecto de Playwright `demo` solo existe con
  `RPA_DEMO=1`, que ya ponen esos dos comandos. `pnpm test:e2e` y el CI nunca la
  corren.
- `RPA_DEMO_HEADLESS`: `1`, `0`, `true` o `false` (cualquier otro valor es un
  error). `RPA_DEMO_SLOWMO`: milisegundos de pausa entre acciones, entero no
  negativo (otro valor es un error). Por defecto 250 con ventana y 0 en
  headless. Ej.: `RPA_DEMO_SLOWMO=600 pnpm demo:rpa`.
- Salida en `apps/e2e/demo-output/<fecha>_<corrida>/` (ignorada por git; cada
  corrida conserva su carpeta, también el `trace.zip`): `summary.md` (tabla
  para proyectar), `summary.json`, `output.xlsx`, `input.xlsx`, `final.png`,
  `video.webm` y `trace.zip`. El trace se abre con
  `pnpm --filter @invoiceops/e2e exec playwright show-trace <carpeta>/trace.zip`.
  La ruta del resumen y su contenido también salen por consola. La carpeta está
  fuera de `test-results/`, que es lo único que sube el CI.
- Si el bot se cae a mitad del lote, la demo igual deja `output.xlsx` y el
  resumen (la fila que se estaba enviando queda `UNCERTAIN` y las pendientes
  `NOT_PROCESSED`, ambas con `error_kind=crash`) y luego falla en las
  comprobaciones. El resumen se escribe después de cerrar el video y el trace y
  solo enlaza lo que existe: lo que no se pudo generar aparece como
  «no generado».
- Además del conteo, el resumen compara cada factura `CREATED*` con la que
  guarda la API (monto, proveedor, fechas, alcance e `id` igual a `invoice_id`);
  las diferencias salen en «Diferencias con la API».
- El trace y el video contienen la contraseña de prueba que el bot escribe:
  son de la base aislada, pero no los publiques. Por eso el spec
  `rpa-invoice-batch` corre sin trace ni capturas y su `error-context.md` se
  borra al terminar (`SECRET_SPECS`).
- Para regenerar la plantilla de la demo:
  `pnpm --filter @invoiceops/e2e rpa:fixture:demo`.

Reglas de oro:

- Decide **siempre** con atributos (`data-*`), nunca con el texto en pantalla.
- Ubica por `id` (es igual a `data-testid`). `name` es el respaldo en inputs.
- Nunca pulses `invoice-create-confirm-new`.
- Los inputs son React: si escribes por JavaScript, usa el setter nativo (§7).

## 0. Notación

| Herramienta | Elemento por id              | Elemento por atributo                           |
| ----------- | ---------------------------- | ----------------------------------------------- |
| UiPath      | `<webctrl id='login-rut' />` | `<webctrl css-selector='[data-screen=auth]' />` |
| PAD         | `input[Id="login-rut"]`      | `main[data-screen="auth"]` (selector CSS)       |
| CSS / JS    | `#login-rut`                 | `[data-screen="auth"]`                          |

En las tablas de abajo se usa la forma CSS; tradúcela con esta tabla.
«Leer atributo» = Get Attribute (UiPath) / Get details of element on web page
→ atributo (PAD). Si alguna herramienta no expone un `data-*`, léelo con JS:
`document.querySelector('#login-error')?.dataset.errorKind ?? ''`.

## 1. Entrada y salida

**Excel de entrada** (hoja con encabezado en la fila 1):

| Columna         | Uso                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `row_id`        | identificador de la fila (para el reporte)                                                                               |
| `organization`  | texto exacto del `<option>` de `#invoice-create-organization`; vacío = solo vale si hay una organización                 |
| `group`         | texto exacto del `<option>` de `#invoice-create-group`; vacío = «Sin grupo asignado» (alcance de organización)           |
| `business_id`   | número de factura                                                                                                        |
| `supplier_name` | proveedor                                                                                                                |
| `amount_pesos`  | monto en dígitos planos (`12500`). El fixture incluye montos mal formados a propósito (`12500,5`) para probar el rechazo |
| `issued_on`     | fecha → convertir a `yyyy-MM-dd`; una fecha que no existe (`31/02/2026`) se deja vacía en el formulario                  |
| `due_on`        | igual que `issued_on`                                                                                                    |
| `status`        | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` o vacío                                                                   |

`expected`, `fault` y `note` del fixture son solo para el test de Playwright:
ignóralas. Son **opcionales**: si la hoja no las trae, se leen vacías. Solo las
nueve columnas de arriba son obligatorias, y `row_id` no puede repetirse (un
`row_id` vacío usa el número de fila de datos, que también debe ser único): el
bot rechaza el Excel y nombra los ids repetidos.

**Excel de salida**: las columnas de entrada más `result`, `invoice_id`,
`error_kind`, `error_status`, `error_code`, `field`, `message`, `attempts`,
`finished_at`.

**Fechas.** El bot convierte a `yyyy-MM-dd` fechas de Excel, números de serie
(se trunca la parte horaria; solo se aceptan series entre 1990-01-01 y
2100-12-31) y texto `dd/mm/aaaa`. Si el día no existe en el calendario
(`31/02/2026`, `2026-02-31`) o la serie está fuera de rango, el campo se deja
vacío: la interfaz rechaza solo esa fila (`REJECTED_FIELD`, `field=issuedOn` o
`dueOn`) y el lote continúa. Un `fill` con una fecha imposible lanzaría
«Malformed value» y tumbaría el lote entero.

Valores de `error_kind` que no vienen de la interfaz: `crash` (el bot se cayó
por un error inesperado, p. ej. un timeout; las filas ya terminadas se
conservan y `message` lleva el error sin credenciales), `interrupted`
(Ctrl-C, SIGTERM o SIGHUP), `reconcile` (ver `RECONCILE_MISMATCH`) y `scope`.

**Fila en vuelo.** Desde que se pulsa «Crear» hasta que se registra su resultado,
la factura puede existir. Si el lote se cae o se interrumpe en ese intervalo, esa
fila queda `UNCERTAIN` (con `error_kind=crash` o `interrupted`) y **no se
reconcilia**: la página ya no es confiable, revísala a mano en la bandeja. Las
filas siguientes quedan `NOT_PROCESSED`; una fila que cayó antes de pulsar
«Crear» también es `NOT_PROCESSED`. Una caída durante la reconciliación final
(todas las filas ya tienen resultado) también cuenta como lote abortado.

Valores de `result`: `CREATED`, `CREATED_AFTER_RETRY`, `CREATED_RECONCILED`,
`REJECTED_FIELD`, `REJECTED`, `ERROR`, `SKIPPED`, `UNCERTAIN`, `MANUAL_REVIEW`,
`NOT_PROCESSED`.

## 2. Login

1. Navegar a la URL base (`/`).
2. Esperar `[data-screen="auth"]` (o `[data-screen="invoices"]` si ya hay
   sesión: saltar al paso 3).

| Acción              | Selector                                  | Notas                                         |
| ------------------- | ----------------------------------------- | --------------------------------------------- |
| Escribir RUT        | `#login-rut` (`name="rut"`)               | con o sin puntos                              |
| Escribir contraseña | `#login-password` (`name="password"`)     | credencial del orquestador, nunca en el Excel |
| Enviar              | `#login-submit`                           |                                               |
| Esperar fin         | `#login-form` deja `data-state="pending"` | o aparece otra pantalla                       |

3. Decidir:

| Señal                                                  | Acción                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `[data-screen="invoices"]` presente                    | OK, seguir                                                                                              |
| `[data-screen="onboarding"]`                           | **Abortar el lote** (requiere cambio de contraseña)                                                     |
| `#login-error[data-error-kind="credentials"]`          | **Abortar**: todas las filas `NOT_PROCESSED`                                                            |
| `#login-error[data-error-kind="forbidden"]`            | Abortar                                                                                                 |
| `#login-error[data-error-kind="rate-limited"]`         | Esperar (ej. 60 s) y reintentar el login                                                                |
| `#login-error[data-error-kind="network"]` / `unknown`  | Reintentar con backoff; al 3.º fallo, abortar                                                           |
| `#login-rut-error` / `#login-password-error` con texto | Dato de login inválido: **abortar** de inmediato (`error_kind=credentials`), sin esperar `#login-error` |

## 3. Ir a crear factura

| Acción              | Selector                                                  |
| ------------------- | --------------------------------------------------------- |
| Abrir menú Facturas | `#nav-invoices` (o navegar a `/invoices`)                 |
| Esperar bandeja     | `[data-screen="invoices"]`                                |
| Nueva factura       | `#invoices-new`                                           |
| Esperar formulario  | `[data-screen="invoice-create"]` y `#invoice-create-form` |

- Si `#invoices-new` no existe o aparece `#invoice-create-forbidden`: la cuenta
  no puede crear. **Abortar** el lote.
- Atajo válido: navegar directo a `/invoices/new`.

## 4. Por cada fila del Excel

### 4.1 Formulario limpio

Partir siempre de un formulario recién abierto: navegar a `/invoices/new` (o
pulsar `#invoice-create-another` tras una creación) y esperar
`#invoice-create-form[data-state="idle"]`.

### 4.2 Resolver el alcance

Los nombres de organización y de grupo no son únicos en la base de datos, así
que cada select se valida antes de elegir:

El bot TypeScript acepta un `group` en blanco (creación a nivel de organización,
solo si la cuenta puede crear en la organización); el robot UiPath de la clase
exige `in_GroupName` y se detiene al comenzar si viene vacío.

1. Leer las opciones de `#invoice-create-organization` (`name="organization"`;
   `value` = id de la organización). Contar las que tienen exactamente el texto
   `organization`:
   - 0 → `ERROR`, `error_code=ORGANIZATION_NOT_FOUND`. Siguiente fila.
   - más de 1 → `ERROR`, `error_code=ORGANIZATION_AMBIGUOUS` (no se adivina).
   - 1 → seleccionarla. `organization` vacía solo vale si la cuenta ve **una**
     organización; si ve varias es ambigua.
2. Leer las opciones de `#invoice-create-group` (`name="group"`), que cambian
   con la organización. Los grupos llegan cuando la API los lista: esperar unos
   segundos antes de dar un grupo por inexistente.
   - `group` vacío → la opción `value` `organization:<orgId>` («Sin grupo
     asignado»).
   - `group` con texto → las opciones `group:<orgId>:<groupId>` con ese texto
     exacto: 0 → `ERROR`, `GROUP_NOT_FOUND`; más de 1 → `ERROR`,
     `GROUP_AMBIGUOUS`; 1 → esa.

JS para listar (Inject JS / Run JavaScript), cambiando el id del select:

```js
JSON.stringify(
  [...document.querySelectorAll("#invoice-create-group option")].map((o) => ({
    value: o.value,
    text: o.text.trim(),
    organizationId: o.dataset.organizationId,
    groupId: o.dataset.groupId ?? null,
  })),
);
```

Si `status` no está entre los `value` de `#invoice-create-business-status` →
`SKIPPED`, `error_code=STATUS_NOT_AVAILABLE`.

### 4.3 Llenar

| Campo        | Selector                          | `name`           | Valor                              |
| ------------ | --------------------------------- | ---------------- | ---------------------------------- |
| Organización | `#invoice-create-organization`    | `organization`   | `value` de 4.2 paso 1 (select)     |
| Grupo        | `#invoice-create-group`           | `group`          | `value` de 4.2 paso 2 (select)     |
| Número       | `#invoice-create-business-id`     | `businessId`     | `business_id`                      |
| Proveedor    | `#invoice-create-supplier-name`   | `supplierName`   | `supplier_name`                    |
| Monto        | `#invoice-create-amount`          | `amount`         | `amount_pesos`                     |
| Estado       | `#invoice-create-business-status` | `businessStatus` | `status` (select; omitir si vacío) |
| Emisión      | `#invoice-create-issued-on`       | `issuedOn`       | `yyyy-MM-dd`                       |
| Vence        | `#invoice-create-due-on`          | `dueOn`          | `yyyy-MM-dd`                       |

Fecha no ISO en el Excel → dejar el campo vacío; la validación lo reportará.

### 4.4 Enviar y esperar

1. Pulsar `#invoice-create-submit`.
2. Esperar (timeout 45 s; la interfaz misma se rinde a los 30 s) a que la **raíz**
   `[data-screen="invoice-create"]` tenga `data-state` distinto de `pending`.
   No esperes sobre el form: al crear, el form desaparece.

### 4.5 Decidir

Leer `data-state` de la raíz y actuar:

| Señal                                                                                        | Resultado / acción                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `success` → `#invoice-create-created`                                                        | `CREATED` (o `CREATED_AFTER_RETRY` si hubo reintento). Guardar `data-invoice-id`. Pulsar `#invoice-create-another`                          |
| `error` + algún `[data-field]` con texto (`#<campo>-error`)                                  | `REJECTED_FIELD`; `field` = `data-field`, `message` = texto. Recargar `/invoices/new`                                                       |
| `#invoice-create-failure[data-failure-kind="uncertain"]`                                     | Pulsar `#invoice-create-retry` con backoff (0,5 s, 1 s, 2 s; máx. 3). Volver a 4.4                                                          |
| `uncertain` agotado                                                                          | `UNCERTAIN`; se reconcilia al final (§6)                                                                                                    |
| `[data-failure-kind="rejected"]`                                                             | `REJECTED`; guardar `data-error-status` y `data-error-code`. Recargar                                                                       |
| `rejected` + `data-error-code="BUSINESS_ID_CONFLICT"` tras un `uncertain` de esta misma fila | Buscar en la bandeja (§5): si está y coincide → `CREATED_RECONCILED`; si difiere → `REJECTED` `RECONCILE_MISMATCH`; si no está → `REJECTED` |
| `[data-failure-kind="burned"]`                                                               | `MANUAL_REVIEW`. Pulsar `#invoice-create-confirm-cancel` o recargar. **Nunca** `#invoice-create-confirm-new`                                |
| `rejected` con `data-error-status="403"`                                                     | `REJECTED`; `error_code` = `data-error-code` (hoy `FORBIDDEN`)                                                                              |
| Aparece `[data-screen="auth"]`                                                               | Sesión expirada: re-login (§2) y buscar la fila en la bandeja (§5) antes de reenviarla                                                      |
| Ninguna señal tras el timeout                                                                | `MANUAL_REVIEW`, recargar y seguir                                                                                                          |

Leer el error de campo por JS:

```js
JSON.stringify(
  [...document.querySelectorAll("[data-screen='invoice-create'] [data-field]")]
    .filter((e) => e.textContent.trim() !== "")
    .map((e) => ({ field: e.dataset.field, message: e.textContent.trim() })),
);
```

## 5. Buscar una factura en la bandeja

Usado para reconciliar (`BUSINESS_ID_CONFLICT` tras `uncertain`, re-login a
mitad de fila, y §6). Que el número exista no basta: una factura de una corrida
anterior tiene el mismo número. Antes de reportar `CREATED_RECONCILED` compara
monto, proveedor, fechas y alcance de la factura con la fila (el bot
la hace solo con los atributos `data-*` de la fila de la bandeja:
`data-amount-pesos`, `data-supplier`, `data-issued-on`, `data-due-on`,
`data-organization-id` y `data-group-id`, ver el contrato de selectores §2; no
llama a la API). Si algo difiere, o falta un atributo, **no** reconcilies: la fila
queda `REJECTED` (en la reconciliación por conflicto o re-login) o `UNCERTAIN` (al cierre) con `error_code=RECONCILE_MISMATCH` y el detalle
en `message`.

1. Navegar a
   `/invoices?organizationId=<orgId>[&groupId=<groupId>]&q=<business_id>`
   (los ids salen del `value` del alcance).
2. Esperar `#invoices-results` con `data-state` = `ready` o `error`. Nunca
   busques filas antes.
3. `ready` → buscar `tr[data-testid="invoices-row"][data-business-id="<business_id>"]`
   - existe → leer `data-invoice-id`: la factura ya está creada.
   - no existe → no está creada.
4. `error` → no se puede afirmar nada: dejar la fila como estaba.

`invoices-row` es el único identificador que se repite: selecciónalo siempre
junto con `data-business-id`.

## 6. Cierre del lote

1. Para cada fila `UNCERTAIN`, buscar en la bandeja (§5). Si aparece →
   `CREATED_RECONCILED` con su `invoice_id`.
2. Filas no procesadas por un aborto → `NOT_PROCESSED` (la fila en vuelo,
   `UNCERTAIN`, sin reconciliar).
3. Escribir el Excel de salida y registrar `finished_at` por fila. Si no se puede
   escribir el Excel, volcar los resultados como JSON en
   `<salida>.results.json` (o por stderr si eso también falla) y terminar con
   código 1.

**Códigos de salida del CLI (`rpa:run`)**: 0 lote terminado; 1 lote abortado o
caído (también si la caída fue en la reconciliación) o resultados que no se
pudieron escribir como Excel; 2 error de entrada (argumentos, columnas
faltantes, `row_id` repetido, `--base-url` inválida; imprime el uso, no un
stack); 129 / 130 / 143 se recibió SIGHUP / SIGINT (Ctrl-C) / SIGTERM, también
si el lote ya había terminado (la señal manda sobre el estado del lote).
**Señales**: el CLI detiene el lote de inmediato, sin esperar la fila que se
estaba enviando: esa fila queda `UNCERTAIN` (`error_kind=interrupted`, sin
reconciliar), las que no empezaron `NOT_PROCESSED`, y el Excel de salida se
escribe con lo terminado (basta con que el Excel de entrada se haya leído: una
señal que llega antes de abrir el navegador deja todas las filas
`NOT_PROCESSED`). Si la señal llega antes de que existan los manejadores (el
arranque, antes de leer argumentos y credenciales), el proceso muere con la
acción por defecto y **no se escribe salida** (no se envió nada). Los
manejadores de señales de Playwright están desactivados (`launchOptions` en
`run-support.ts`, con prueba unitaria) para que no cierren el navegador ni
salgan con 130 mientras se escribe la salida. Los manejadores del CLI no se
quitan hasta que el proceso termina: una señal que llega justo después del
lote solo fija el código de salida (128+N), nunca la acción por defecto.
Una segunda señal sale sin escribir más, pero **espera a que termine una
escritura atómica en curso** (es corta) y luego sale con 128+N, así que no queda
un `.tmp-<pid>-<hex>` suelto ni falta la salida; una **tercera señal**, o **10 s**
después de la segunda si la escritura no termina, fuerza la salida (y borra el
temporal en curso). Si la limpieza falla (EBUSY/EPERM al borrar un temporal o el
directorio de trabajo), el CLI avisa por stderr y sale igual con 128+N; un
borrado que falla no impide borrar el resto. **Precedencia del código**: señal recibida (129 / 130 / 143) >
error de entrada (2) > otra caída (1) > resultado del lote; el propio manejador de
la señal fija el código, también si llega tras calcular el resultado o mientras
se lee el Excel. El lanzador `e2e-backend.mjs` sigue la misma regla: si recibió
una señal sale con 128+N aunque el servidor haya salido con 0. Además reenvía la
señal al servidor y, si este no sale en 8 s (antes de los 10 s de Playwright), le envía SIGKILL; si el servidor o
la semilla emiten `error` (no se pudieron lanzar), imprime una línea
`[e2e-backend]` y sale con 1 (128+N si ya se estaba deteniendo).
**Escritura atómica**: el Excel (y el `.results.json` de respaldo) se escribe en
`<salida>.tmp-<pid>-<hex aleatorio>` (creado de forma exclusiva, sin seguir
enlaces simbólicos) y se renombra al terminar; nunca queda un archivo final
truncado. Si `--output` es un enlace simbólico se escribe a través del enlace: el
enlace se conserva y se actualiza el archivo al que apunta (el archivo temporal
queda junto al destino real). `--output` sigue sin poder ser la entrada, tampoco
mediante un enlace. En Windows (mejor esfuerzo: el stack E2E apunta a macOS y
Linux) el `rename` sobre un archivo abierto (EPERM/EBUSY, p. ej. el Excel abierto
en Excel) se reintenta unas veces con una espera corta antes de caer al
`.results.json`, y `recovery-local-reset` lanza `prisma.cmd` con `shell: true`.

Antes del `rename` se comprueba de nuevo que la carpeta real (`realpath`) del
destino no cambió; si cambió, la escritura falla. Es una comprobación barata, no
una defensa: un atacante local que cambie un enlace simbólico entre la
resolución del destino y el `rename` queda fuera de alcance (CLI local, carpetas
del propio usuario).

**Solución de problemas del stack E2E (`e2e-backend.mjs`)**: si el lanzador
muere con SIGKILL (ningún manejador lo puede atrapar), el backend hijo se
detecta solo y termina (se lanza con un canal IPC y un precargador,
`scripts/exit-with-parent.mjs`, que sale cuando el canal se cierra). Lo que no
se puede cubrir es el grupo `prisma migrate deploy` si el SIGKILL cae justo
durante el reset: es corto, pero puede dejar un proceso `prisma` huérfano. Si el
siguiente arranque dice `port 4391 is already in use`, el mensaje trae los PID
que escuchan en ese puerto (necesita `lsof`; si no está, no se muestran) y el
comando exacto, por ejemplo `kill 12345`. Revisa antes con
`ps -Ao pid,command | rg "e2e-backend|src/server.ts|prisma"` y mata solo lo que
sea un resto de una ejecución E2E.

## 7. Inputs React por JavaScript

Si escribes con Type Into / Populate text field funciona igual que un humano.
Si asignas por JS, usa el setter nativo o el formulario no se entera:

```js
function setValue(id, value) {
  const el = document.getElementById(id);
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}
setValue("invoice-create-issued-on", "2026-10-25");
setValue("invoice-create-organization", "<orgId>");
setValue("invoice-create-group", "organization:<orgId>");
```

## 8. Selectores prohibidos

No uses: ids `:r3:` de React, `nth-child`, `idx=`, clases CSS
(`.field-error`, `.toast-message`), XPath absoluto, coordenadas, imágenes ni
texto en español para decidir. Ver §6 del contrato.

## 9. Probar el bot

- Fixture: `apps/e2e/rpa/fixtures/invoice-batch.xlsx` (16 filas: camino feliz,
  cada error y 7 filas con falla inyectada). Los placeholders `{{ORG}}`,
  `{{GROUP}}`, `{{UNKNOWN_GROUP}}` (un grupo que la cuenta no tiene) y `{{RUN}}`
  (prefijo que hace únicos los números de factura) se reemplazan con datos de
  tu entorno. `demo-batch.xlsx` usa los mismos placeholders, sin fallas.
- Resultado esperado por fila: columna `expected`.
- Las filas con `fault` solo se reproducen en Playwright, que inyecta la falla
  en `POST /api/v1/invoices`: `503-once`, `network-once`, `503-always`,
  `lost-response-always`, `idempotency-409`, `forbidden-403` y
  `session-expired`. En UiPath/PAD trátalas como camino feliz o sáltalas.
- Referencia: `pnpm --filter @invoiceops/e2e rpa:run -- --input <xlsx> --output <xlsx>`
  (ver `apps/e2e/rpa/README.md`). Solo escribe credenciales en `localhost`,
  `127.0.0.1` o `[::1]`; otro destino exige `--allow-remote` y https.
