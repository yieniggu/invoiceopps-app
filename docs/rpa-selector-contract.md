# Contrato de selectores para automatización (RPA y e2e)

Estado: **aceptado** · Fecha: 2026-11-05 · Alcance: login → facturas → crear
facturas en lote.

Este documento fija qué atributos expone la interfaz para que un bot
(Playwright, UiPath o Power Automate Desktop) la recorra sin depender del texto
en español ni del layout. Es un **contrato**: cambiar un valor de esta tabla es
un cambio incompatible para los bots y se trata como tal.

## 1. Contexto

- La interfaz se automatiza hoy solo con selectores accesibles (`getByLabel`,
  `getByRole`), acoplados al texto en español.
- Los `id` los genera `useId` (`:r3:`), cambian entre builds y no sirven como
  selector.
- El estado del formulario (enviando, creada, tipo de fallo) solo se ve en el
  texto. Un bot tendría que comparar mensajes para decidir si reintenta.
- UiPath y Power Automate Desktop anclan de forma nativa en `id`, `name` y el
  nombre accesible. `data-testid` es nativo solo en Playwright
  (`getByTestId`, atributo por defecto, sin configuración extra).

## 2. Decisión

### 2.1 Triple ancla en cada elemento del recorrido

Cada elemento que un bot toca lleva:

| Atributo      | Valor                                     | Para quién                                                     |
| ------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `id`          | el identificador del contrato             | UiPath (`<webctrl id='…' />`), PAD (`input[Id="…"]`), CSS `#…` |
| `data-testid` | **el mismo** identificador                | Playwright (`getByTestId`)                                     |
| `name`        | nombre del campo de la API (`businessId`) | solo inputs y selects; respaldo para UiPath y PAD              |

Reglas:

- Identificadores en **kebab-case**, con el formato `<pantalla>-<elemento>`.
  Sin puntos, para que `#id` funcione en CSS sin escapes.
- Cada identificador aparece **una sola vez** en la página.
- El `id` del contrato reemplaza al de `useId` en ese elemento. Los
  `htmlFor` y `aria-describedby` apuntan al nuevo `id`.
- El mensaje de error de un campo es `<id-del-campo>-error`.
- El texto visible y el nombre accesible no cambian. El contrato se **suma** a
  la accesibilidad, no la reemplaza.

### 2.2 Estado legible como atributo

El bot decide con atributos, nunca con texto.

| Atributo               | Dónde                                                                          | Valores                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-screen`          | elemento raíz de las pantallas del recorrido del bot (lista abajo)             | `auth`, `onboarding`, `invoices`, `invoice-create`, `loading` (preparando la sesión), `session-error` (el perfil no cargó)                                                                                                                                                                                                               |
| `data-auth-reason`     | `main` de `auth`                                                               | `logout` (salida voluntaria), `expired` (la sesión terminó con 401), `none` (no había sesión)                                                                                                                                                                                                                                            |
| `data-state`           | `login-form`, `invoice-create-form` y la raíz `[data-screen="invoice-create"]` | `idle`, `pending`, `success`, `error` (`error`: en login, la request falló; en crear factura, también un error de campo). Sin permiso de crear, la raíz queda en `idle`                                                                                                                                                                  |
| `data-state`           | `invoices-results` (bandeja)                                                   | `loading`, `ready` (la página pedida, con filas o vacía, está en pantalla y no hay nada cargando), `error`. Siempre presente en la bandeja: `loading` mientras se resuelven los grupos de la URL, `ready` si no hay ningún alcance legible (estado vacío, sin request)                                                                   |
| `data-error-kind`      | `invoices-results` (bandeja)                                                   | solo con `data-state="error"` por rango inválido: `invalid-range` («Desde» posterior a «Hasta», no se envía request). Un fallo de la lista no lleva este atributo                                                                                                                                                                        |
| `data-error-kind`      | `login-error`                                                                  | `credentials` (400/401), `forbidden` (403), `rate-limited` (429), `network` (sin respuesta: `fetch` rechaza con `TypeError`, o se corta por timeout/abort), `unknown` (HTTP no mapeado, p. ej. 5xx, o cualquier otra excepción que no sea de red; el `data-error-code` es el de la API, o `UNKNOWN` sin respuesta)                       |
| `data-failure-kind`    | `invoice-create-failure`                                                       | `uncertain` (puede haberse creado: sin respuesta, 5xx o cualquier excepción inesperada tras enviar; se reintenta con la misma clave), `burned`, `rejected`. El elemento solo existe mientras el fallo está vigente: desaparece en cuanto se envía un reintento y no se muestra un fallo anterior mientras la nueva request está en vuelo |
| `data-error-status`    | `login-error`, `invoice-create-failure`                                        | código HTTP (`409`) o vacío si no hubo respuesta                                                                                                                                                                                                                                                                                         |
| `data-error-code`      | `login-error`, `invoice-create-failure`                                        | `error.code` de la API tal cual (`BUSINESS_ID_CONFLICT`), `NETWORK` sin respuesta, `UNKNOWN` ante una excepción que no es de red (solo en `uncertain` de crear factura y `unknown` de login), vacío si la API no envió código                                                                                                            |
| `data-field`           | cada `*-error` de campo                                                        | nombre del campo (`businessId`)                                                                                                                                                                                                                                                                                                          |
| `data-invoice-id`      | `invoice-create-created`, `invoices-row`                                       | UUID de la factura                                                                                                                                                                                                                                                                                                                       |
| `data-business-id`     | `invoice-create-created`, `invoices-row`                                       | número de la factura                                                                                                                                                                                                                                                                                                                     |
| `data-organization-id` | `invoices-row`                                                                 | UUID de la organización de la factura                                                                                                                                                                                                                                                                                                    |
| `data-group-id`        | `invoices-row`                                                                 | UUID del grupo, o cadena vacía en el alcance de organización                                                                                                                                                                                                                                                                             |
| `data-supplier`        | `invoices-row`                                                                 | nombre exacto del proveedor, sin recortar ni formatear (puede llevar comillas y tildes)                                                                                                                                                                                                                                                  |
| `data-amount-pesos`    | `invoices-row`                                                                 | monto en pesos enteros, solo dígitos, sin separadores ni símbolo (`1234567`)                                                                                                                                                                                                                                                             |
| `data-issued-on`       | `invoices-row`                                                                 | fecha de emisión `yyyy-mm-dd`, el mismo valor que devuelve la API, sin cambio de zona horaria                                                                                                                                                                                                                                            |
| `data-due-on`          | `invoices-row`                                                                 | fecha de vencimiento `yyyy-mm-dd`, con el mismo criterio                                                                                                                                                                                                                                                                                 |

**Qué pantallas llevan `data-screen`.** Solo las del recorrido del bot: login
(`auth`), preparación de sesión (`loading`), fallo de perfil (`session-error`),
onboarding (`onboarding`), bandeja (`invoices`) y crear factura
(`invoice-create`). Las demás pantallas (panel, detalle de factura, grupos y el
resto) no lo llevan, y un bot no debe depender de él allí.

`aria-invalid="true"` en el input y texto no vacío en `<id>-error` siguen siendo
la señal de error de campo; `data-field` dice a qué campo pertenece.

**Datos de la fila (`invoices-row`).** Los seis atributos `data-organization-id`,
`data-group-id`, `data-supplier`, `data-amount-pesos`, `data-issued-on` y
`data-due-on`, junto con `data-business-id`, están **siempre presentes** en cada
fila y llevan el valor crudo de la factura, no el texto visible (que está
formateado para la persona: `$ 12.500`, `25-10-2026`). Para reconciliar, el bot
compara esos atributos con la fila de entrada y no consulta la API: monto como
entero, proveedor por igualdad exacta (tras recortar el de la fila de entrada),
fechas como texto ISO y alcance por `data-organization-id` y `data-group-id`
(vacío = organización). Si falta un atributo, la comparación no es concluyente y
la fila no se reconcilia.

## 3. Catálogo

### Login (`data-screen="auth"`)

| Identificador                             | Elemento                      | Extra                                                     |
| ----------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `login-form`                              | `form`                        | `data-state`                                              |
| `login-rut` / `login-rut-error`           | input RUT y su mensaje        | `name="rut"`                                              |
| `login-password` / `login-password-error` | input contraseña y su mensaje | `name="password"`                                         |
| `login-submit`                            | botón «Iniciar sesión»        |                                                           |
| `login-error`                             | alerta de fallo               | `data-error-kind`, `data-error-status`, `data-error-code` |

### Sesión (`data-screen="loading"` y `data-screen="session-error"`)

Pantallas intermedias, sin identificadores propios. `loading`: se está
resolviendo la sesión (el bot espera a que cambie). `session-error`: el perfil
no se pudo cargar (la pantalla ofrece «Reintentar»); no es un estado del que el
bot se recupere solo.

### Onboarding (`data-screen="onboarding"`)

El bot **no** completa este paso: si aparece, aborta el lote (requiere a una
persona). Solo necesita el marcador de pantalla.

### Navegación y bandeja (`data-screen="invoices"`)

| Identificador      | Elemento                                                                                                                                               | Extra                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav-invoices`     | enlace «Facturas» del menú                                                                                                                             |                                                                                                                                                       |
| `invoices-new`     | botón «Nueva factura»                                                                                                                                  | ausente si no hay permiso de crear                                                                                                                    |
| `invoices-table`   | tabla                                                                                                                                                  | `aria-busy` mientras carga                                                                                                                            |
| `invoices-results` | estado de la lista (siempre presente en la bandeja, también cargando grupos y sin alcance legible; oculto a la vista salvo el aviso de rango inválido) | `data-state`, `data-error-kind` (`invalid-range`); esperar `ready` antes de buscar filas                                                              |
| `invoices-row`     | cada fila (se repite: es la única excepción a la unicidad)                                                                                             | `data-invoice-id`, `data-business-id`, `data-organization-id`, `data-group-id`, `data-supplier`, `data-amount-pesos`, `data-issued-on`, `data-due-on` |

### Crear factura (`data-screen="invoice-create"`)

| Identificador                    | Elemento                                                                                                                                                                        | Extra                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice-create-form`            | `form`                                                                                                                                                                          | `data-state` (sin `success`: al crear, el formulario se reemplaza)                                                                                                                                                                                  |
| `invoice-create-organization`    | select de organización (solo donde se puede crear)                                                                                                                              | `name="organization"`; `value` = id de la organización; cada `<option>` lleva `data-organization-id`. El nombre no es único: un nombre repetido es ambiguo, nunca se elige la primera                                                               |
| `invoice-create-group`           | select de grupo de la organización elegida (cambiar la organización lo reinicia)                                                                                                | `name="group"`; `value` = `organization:<orgId>` («Sin grupo asignado») o `group:<orgId>:<groupId>`; cada `<option>` lleva `data-organization-id` y, si es un grupo, `data-group-id`. El nombre de grupo tampoco es único dentro de la organización |
| `invoice-create-business-id`     | número de factura                                                                                                                                                               | `name="businessId"`                                                                                                                                                                                                                                 |
| `invoice-create-supplier-name`   | proveedor                                                                                                                                                                       | `name="supplierName"`                                                                                                                                                                                                                               |
| `invoice-create-amount`          | monto                                                                                                                                                                           | `name="amount"`                                                                                                                                                                                                                                     |
| `invoice-create-business-status` | select de estado                                                                                                                                                                | `name="businessStatus"`; valores `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`                                                                                                                                                                     |
| `invoice-create-issued-on`       | fecha de emisión (`type=date`, ISO)                                                                                                                                             | `name="issuedOn"`                                                                                                                                                                                                                                   |
| `invoice-create-due-on`          | fecha de vencimiento                                                                                                                                                            | `name="dueOn"`                                                                                                                                                                                                                                      |
| `<campo>-error`                  | mensaje de cada campo                                                                                                                                                           | `data-field`                                                                                                                                                                                                                                        |
| `invoice-create-submit`          | botón «Crear factura»                                                                                                                                                           |                                                                                                                                                                                                                                                     |
| `invoice-create-failure`         | alerta de fallo                                                                                                                                                                 | `data-failure-kind`, `data-error-status`, `data-error-code`                                                                                                                                                                                         |
| `invoice-create-retry`           | «Reintentar» (solo `uncertain`)                                                                                                                                                 |                                                                                                                                                                                                                                                     |
| `invoice-create-retrying`        | marcador vacío mientras el reintento («Reintentar») está en vuelo                                                                                                               | informativo: el bot no depende de él; esperar `data-state`. Elemento sin texto (la única señal visible es la etiqueta «Creando factura…» del botón de envío), sin `role` ni `data-failure-kind`; reserva el lugar de la alerta con estilo neutro    |
| `invoice-create-sending`         | marcador vacío mientras se reenvía tras un fallo que no es de reintento: tras un rechazo o una clave quemada, y también con «Crear como operación nueva» tras un fallo incierto | informativo: el bot no depende de él; esperar `data-state`. Elemento sin texto, sin `role` ni `data-failure-kind`; reserva el lugar de la alerta con estilo neutro mientras la nueva request está en vuelo                                          |
| `invoice-create-confirm-new`     | «Crear como operación nueva»                                                                                                                                                    | **un bot nunca lo pulsa**                                                                                                                                                                                                                           |
| `invoice-create-confirm-cancel`  | «Cancelar» de la confirmación                                                                                                                                                   |                                                                                                                                                                                                                                                     |
| `invoice-create-forbidden`       | aviso «No tienes permiso para crear facturas»                                                                                                                                   | la raíz lleva `data-state="idle"`                                                                                                                                                                                                                   |
| `invoice-create-created`         | sección «Factura creada»                                                                                                                                                        | `data-invoice-id`, `data-business-id`                                                                                                                                                                                                               |
| `invoice-create-another`         | «Crear otra»                                                                                                                                                                    |                                                                                                                                                                                                                                                     |

## 4. Qué hace el bot con cada estado

| Señal                                                                    | Acción                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `invoice-create-created`                                                 | Registrar `data-invoice-id`; pulsar `invoice-create-another`                            |
| campo con `aria-invalid="true"`                                          | Fila rechazada (campo + mensaje); recargar `/invoices/new`                              |
| `data-failure-kind="uncertain"`                                          | `invoice-create-retry` hasta N veces con espera creciente (misma clave, no duplica)     |
| `data-failure-kind="burned"`                                             | Marcar `MANUAL_REVIEW`; recargar. Nunca confirmar una operación nueva                   |
| `data-failure-kind="rejected"`                                           | Registrar `data-error-code`; recargar                                                   |
| `rejected` + `BUSINESS_ID_CONFLICT` tras un `uncertain` de la misma fila | Probablemente ya se creó: buscar `data-business-id` en la bandeja antes de marcar error |
| `data-screen="auth"` a mitad del lote                                    | Re-login; verificar la fila en curso en la bandeja antes de reenviarla                  |
| `data-screen="onboarding"` o `login-error` con `credentials`             | Abortar el lote                                                                         |
| `login-error` con `rate-limited`                                         | Esperar y reintentar el login                                                           |

## 5. Uso por herramienta

|                       | Playwright                                                                                            | UiPath                                   | Power Automate Desktop                            |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| Ubicar                | `page.getByTestId("invoice-create-amount")`                                                           | `<webctrl id='invoice-create-amount' />` | `input[Id="invoice-create-amount"]`               |
| Leer estado           | `locator.getAttribute("data-state")`                                                                  | Get Attribute `data-state`               | Get details of element on web page → `data-state` |
| Esperar fin del envío | `expect(page.locator('[data-screen="invoice-create"]')).not.toHaveAttribute("data-state", "pending")` | Retry Scope + Get Attribute              | Loop + Get details + Wait (con timeout)           |

En crear factura, espera sobre la raíz de la pantalla y no sobre el formulario: al crear, el formulario desaparece y solo la raíz pasa a `success`.

**Inputs controlados por React.** Asignar `value` por JavaScript (Inject JS
Script en UiPath, Run JavaScript en PAD) no actualiza el formulario. Usa el
setter nativo y dispara `input`; `fill()` de Playwright ya lo hace:

```js
const el = document.getElementById("invoice-create-issued-on");
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
  el,
  "2026-10-25",
);
el.dispatchEvent(new Event("input", { bubbles: true }));
```

Para los `select`, lo mismo con `HTMLSelectElement.prototype` y el evento
`change`.

**Datos del Excel.** Monto como dígitos planos (`12500`); fechas convertidas a
`yyyy-MM-dd` (el Excel las entrega como fecha o número de serie).

## 6. Selectores: fuertes y débiles

| Nivel     | Ejemplo                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Fuerte    | `#invoice-create-business-id`, `getByTestId("invoice-create-form")`, `[data-failure-kind="uncertain"]`, `option[value="group:<org>:<grp>"]` |
| Medio     | `getByLabel("Proveedor")`, `getByRole("button", { name: "Crear factura" })`, `<webctrl aaname='Facturas' tag='A' />` (dependen del texto)   |
| Débil     | ids de `useId` (`#\:r3\:`), `.form-row > .form-field:nth-child(2) input`, `p.field-error`, `.toast-message`, `idx='1'`, `:eq(0)`            |
| Prohibido | XPath absoluto, coordenadas, reconocimiento de imagen                                                                                       |

## 7. Consecuencias

- Los `id` del contrato son globales en la página: dos instancias del mismo
  formulario en una pantalla romperían la unicidad. Hoy no ocurre en este
  recorrido.
- Renombrar un identificador o un valor de estado rompe los bots: se anuncia y
  se mantiene el valor anterior durante una transición.
- Los atributos van también a producción, que es donde corre un RPA. Los
  proveedores, montos y fechas que exponen ya están visibles en pantalla. Lo
  único que la pantalla no muestra son tres identificadores UUID: el de la
  factura (`data-invoice-id`), el de la organización (`data-organization-id`) y
  el del grupo (`data-group-id`). La persona ya puede obtenerlos con la API, y
  la organización además aparece en la URL de la bandeja; el de la factura está
  en la URL de «Ver factura».
- Pendiente de comprobar con el inspector de cada herramienta, una vez
  implementado: que PAD muestre los `data-*` en «Get details» y que UiPath los
  lea con Get Attribute. Si no, el respaldo es leerlos con JavaScript.

## 8. Implementación (slices)

| Slice | Contenido                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Este contrato                                                                                                                                                 |
| S2    | Componentes compartidos (`FieldMessage`, `RutField`, `PasswordInput`, `Field`) aceptan `id`/`name`; campos de crear factura cableados; marcador `data-screen` |
| S3    | Login, onboarding y sesión expirada                                                                                                                           |
| S4    | Crear factura: `data-state`, fallo con tipo y código, factura creada con id                                                                                   |
| S5    | Menú y bandeja: `nav-invoices`, `invoices-new`, filas con ids                                                                                                 |
| S6    | Bots de referencia (Playwright, UiPath, PAD) con un Excel de fixtures que cubre el camino feliz y cada error                                                  |
