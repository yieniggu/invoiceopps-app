# Crear facturas con curl y Python (guía de aula)

Dos clientes pequeños, sin SDK ni instalaciones, crean y leen facturas contra la
app **local** usando un token de API:

- [`examples/recovery/create-invoice.sh`](../examples/recovery/create-invoice.sh) (bash + curl)
- [`examples/recovery/create-invoice.py`](../examples/recovery/create-invoice.py) (Python 3, solo biblioteca estándar)

Requisitos: la app corriendo en local ([`LOCAL_RUN.md`](../LOCAL_RUN.md)), `curl`
y `python3`. Los contratos son los de Swagger (`/docs`) y la interfaz web; los
ejemplos no los redefinen.

## 1. Obtén los identificadores desde la web

No inventes UUID. Con tu sesión iniciada en `http://127.0.0.1:5380`:

- **Organización**: abre **Organizaciones**, entra a tu organización y copia el
  UUID de la barra de direcciones (`/organizations/<organizationId>`).
- **Grupo** (opcional): dentro de la organización abre **Grupos** y entra al
  grupo; el UUID es el último tramo de la dirección
  (`/organizations/<organizationId>/groups/<groupId>`).

Sin `groupId` la factura queda en el alcance **organización**; con `groupId`, en
el alcance **grupo**.

## 2. Emite un token en «Tokens de API»

1. Abre **Tokens de API** y crea un token para la misma organización (y el mismo
   grupo, si vas a usar alcance de grupo).
2. Marca los scopes `invoices:read` e `invoices:create`.
3. Copia el secreto `iop_…`: se muestra **una sola vez**. Un token nunca da más
   permisos de los que ya tiene tu usuario en ese alcance.

Para emitir un token de alcance de grupo basta tu membresía en la organización,
con permisos efectivos que cubran los scopes pedidos; no hace falta ser miembro
del grupo. Un token usado contra otra organización distinta de la suya responde
`404`.

Al emitir hay límites: 20 intentos cada 15 minutos por persona (`429
RATE_LIMITED`: espera) y 50 tokens activos por persona y organización (`409
TOKEN_LIMIT`: revoca alguno que ya no uses). Los scripts validan además que los
identificadores (`--organization-id`, `--group-id`, `--invoice-id`) sean UUID y
que `INVOICEOPS_TIMEOUT_SECONDS` sea un entero positivo; si no, terminan con
código 2 antes de leer el token.

## 3. Entrega el secreto sin eco

Los scripts **no aceptan el token como argumento** y nunca lo imprimen ni lo
guardan. Lo leen, en este orden, de:

1. la variable `INVOICEOPS_TOKEN` (útil para automatizar);
2. un prompt silencioso si hay terminal (`read -rs` / `getpass`);
3. la primera línea de la entrada estándar.

```sh
# Interactivo: el script pregunta y no muestra lo que pegas
./examples/recovery/create-invoice.sh create \
  --base-url http://127.0.0.1:4380 --organization-id <organizationId>
```

El script de bash entrega la cabecera `Authorization` a curl por `--config -`
(entrada estándar), así que el token no aparece en la lista de procesos. Evita
escribirlo en la línea de comandos o en archivos: quedaría en el historial.

## 4. Ejecuta los ejemplos

La **URL base solo puede ser loopback** (`127.0.0.1`, `localhost` o `::1`); con
cualquier otra el script termina con error **antes** de leer el token o abrir la
red.

```sh
BASE=http://127.0.0.1:4380
ORG=<organizationId>
GROUP=<groupId>

# Alcance organización
./examples/recovery/create-invoice.sh create --base-url "$BASE" --organization-id "$ORG"
python3 examples/recovery/create-invoice.py create --base-url "$BASE" --organization-id "$ORG"

# Alcance grupo
./examples/recovery/create-invoice.sh create --base-url "$BASE" --organization-id "$ORG" --group-id "$GROUP"
python3 examples/recovery/create-invoice.py create --base-url "$BASE" --organization-id "$ORG" --group-id "$GROUP"
```

Cada `create` recorre el mismo flujo e imprime solo códigos HTTP y datos de la
factura:

1. **crear**: `POST /api/v1/invoices` → `201` (monto en pesos CLP enteros;
   por defecto 12500).
2. **repetir**: misma `Idempotency-Key` y misma carga → `201` con la **misma**
   factura (`replay=true`), sin duplicados.
3. **conflicto**: misma clave con otra carga → `409`, esperado; no se reintenta.
4. **GET**: sigue la cabecera `Location` y lee la misma factura.

Opciones útiles: `--business-id`, `--supplier-name`, `--amount-pesos`,
`--issued-on`, `--due-on` y `--idempotency-key`. Para leer una factura existente:

```sh
./examples/recovery/create-invoice.sh get --base-url "$BASE" \
  --organization-id "$ORG" --invoice-id <invoiceId>
```

Compara el resultado refrescando **Facturas** en la aplicación web.

## 5. Idempotencia

La clave identifica el **intento** (16 a 128 caracteres `A-Z a-z 0-9 _ -`).

- Si hay un **timeout** o se corta la red, no sabes si la factura se creó:
  repite con la **misma clave y la misma carga** (los scripts la imprimen al
  inicio y al fallar; pásala con `--idempotency-key` y conserva `--business-id`).
  Una clave nueva podría crear un duplicado.
- Un **`409`** significa que la clave ya se usó con otra carga, o que el
  `businessId` ya existe: **no reintentes a ciegas**; corrige la carga o usa otra
  clave de forma consciente.

## 6. Revocar el token

En **Tokens de API** revoca el token. Desde ese momento cualquier `create` o
`get` termina con `401` y salida distinta de cero; emite uno nuevo para seguir.
Tus tokens también se revocan solos cuando cambias tu contraseña o cuando una
administración de plataforma desactiva tu cuenta, restablece tu contraseña o
cambia tu RUT.

Las lecturas con Bearer no toman bloqueos: una lectura cuya transacción comenzó
antes de que la revocación se confirmara aún puede devolver datos; cualquier
solicitud que comience después de esa confirmación se rechaza con `401`.

## 7. Errores y qué hacer

| HTTP  | Significado                                               | Qué hacer                                                                                |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `400` | Clave de idempotencia o campos inválidos                  | Corrige el formato; no se guardó nada                                                    |
| `401` | Token inválido, vencido o revocado                        | Emite un token nuevo                                                                     |
| `403` | Falta el scope del token o el permiso de tu usuario       | Revisa scopes y permisos; `ONBOARDING_REQUIRED`: cambia tu contraseña temporal en la web |
| `404` | Organización o grupo inexistentes o sin acceso            | Copia de nuevo los identificadores desde la web                                          |
| `409` | Clave reutilizada con otra carga, o `businessId` repetido | No reintentar a ciegas                                                                   |
| `410` | La factura de esa clave fue eliminada                     | No se restaura ni se recrea; usa otra clave y otro `businessId`                          |
| `429` | Demasiadas solicitudes                                    | Espera unos minutos e inténtalo de nuevo                                                 |
| `503` | Conflicto transitorio de concurrencia                     | Espera y reintenta con la misma clave y carga                                            |

Los scripts traducen estos códigos a mensajes en español y terminan con código
distinto de cero ante cualquier respuesta inesperada. Ninguno imprime el token.

## 8. Verificación automática

`pnpm test:recovery:clients` ejecuta estos mismos archivos contra el backend real
y la base PostgreSQL aislada de pruebas (token emitido y revocado por la API real,
alcance organización y grupo, sin secreto en la salida, URL remota rechazada).
Se corre con el entorno de [`LOCAL_RUN.md`](../LOCAL_RUN.md) (`RECOVERY_TEST_DATABASE_URL`).
