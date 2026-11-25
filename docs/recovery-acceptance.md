# Aceptación P0: criterios G01–G20 y su evidencia

Cómo se certifica la recuperación P0 en local, desde una base limpia. Cada
criterio global (G01–G20, definidos en el índice del backlog de recuperación)
apunta a una prueba que se ejecuta de verdad, sin mocks de los límites críticos
ni servicios externos, y sin pruebas omitidas (`skip`).

## Cómo ejecutarla

```sh
set -a; . ./.env; set +a            # POSTGRES_* y LOCAL_APP_DB_PORT (ver LOCAL_RUN.md)
pnpm test:recovery:e2e              # compuerta de certificación P0 (recorrido RP0-20)
pnpm test:e2e                       # regresión completa de la interfaz (3 proyectos)
export RECOVERY_TEST_DATABASE_URL=… # ver LOCAL_RUN.md
pnpm test:recovery:postgres         # suites con PostgreSQL real
pnpm test:recovery:clients          # clientes curl y Python reales
pnpm test:integration               # PostgreSQL efímero en Docker, migraciones
pnpm test:unit                      # unitarias, HTTP y de contratos de todos los paquetes
```

- **Compuerta de certificación (CR-247):** `pnpm test:recovery:e2e`. Ejecuta el
  recorrido integrado [`apps/e2e/tests/recovery-journey.spec.ts`](../apps/e2e/tests/recovery-journey.spec.ts)
  en escritorio claro y oscuro, contra la base dedicada `invoiceops_recovery_e2e`,
  que se recrea en cada corrida. `pnpm test:e2e` es la regresión completa de la
  interfaz e incluye el recorrido.
- **Sin PostgreSQL, Docker, navegador, `curl` o `python3`, las suites fallan;
  nunca se omiten.**
- Las suites E2E y `test:recovery:postgres` usan bases distintas, así que
  pueden correr a la vez.
- En CI, `recovery-postgres` e `integration` corren en cada push y PR. El job
  `e2e` (recorrido y regresión) se lanza a mano (`workflow_dispatch`).

## El recorrido RP0-20, paso a paso

Una sola prueba en la que todas las superficies actúan sobre las **mismas
filas** de PostgreSQL:

1. La plataforma crea a dos personas **sin organización** desde el asistente
   de Admin; cada contraseña temporal se ve una vez.
2. La plataforma crea la organización (un curso) con la primera persona como
   ADMIN.
3. La ADMIN crea un grupo en la interfaz, agrega a la segunda persona por RUT y
   le asigna permisos por usuario: crear en la organización; leer, crear y
   eliminar las propias en el grupo. Una tercera persona entra al mismo grupo
   solo con lectura.
4. El primer ingreso exige cambiar la contraseña temporal y rechaza repetirla.
5. La persona crea en React una factura de organización y otra de grupo. En el
   grupo ve la del grupo y no la de la organización (no tiene lectura de
   organización).
6. Emite en React un token de alcance grupo; el secreto se muestra una vez.
7. En un navegador **sin cookie**, Swagger hace Authorize con Bearer, `POST`
   (201) y `GET`. React, al refrescar, muestra esa factura.
8. Los clientes curl y Python crean con clave de idempotencia (con replay), y
   React las lista.
9. La lectora recibe 403 al eliminar. La autora elimina la suya desde React.
10. La ADMIN le quita la lectura de grupo en la interfaz. Las siguientes
    peticiones de esa persona, por sesión y por Bearer, reciben 403; la lectora
    sigue con 200. La ADMIN, sin permisos de factura, lee (solo lectura) las facturas de su organización y no puede eliminarlas.
11. La revocación en React deja a Swagger y a ambos clientes en 401, aunque la
    sesión de la persona sigue abierta.
12. Ningún navegador pidió nada fuera de loopback y ninguna página conserva el
    secreto.

## Matriz de trazabilidad

`journey` = `apps/e2e/tests/recovery-journey.spec.ts`. Las rutas de las
pruebas del backend son relativas a `apps/backend/test/recovery/`, las E2E a
`apps/e2e/tests/` y las de interfaz a `apps/frontend/src/`.

| ID  | Criterio                                                                                                                                                                                 | Evidencia en ejecución                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G01 | Inicio limpio con PostgreSQL local y migración consolidada                                                                                                                               | Cada E2E recrea y migra su base (`apps/backend/scripts/e2e-backend.mjs`); `pnpm test:integration` aplica las migraciones a un PostgreSQL efímero y verifica el registro; `schema.postgres.test.ts`; job `schema-drift`                     |
| G02 | Bootstrap entrega primer administrador que inicia sesión                                                                                                                                 | `bootstrap.postgres.test.ts`, `bootstrap.unit.test.ts`; `auth.spec.ts`; journey (paso 4)                                                                                                                                                   |
| G03 | Organización, grupo, usuario y membresías múltiples desde UI                                                                                                                             | journey (pasos 1–3); `organizations.spec.ts`, `groups.spec.ts`, `admin-wizard.spec.ts`                                                                                                                                                     |
| G04 | Login temporal obliga a contraseña diferente                                                                                                                                             | journey (paso 4: rechaza la misma); `auth.spec.ts`; `auth.postgres.test.ts`                                                                                                                                                                |
| G05 | Login autorizado y sin escalamiento plataforma/ADMIN                                                                                                                                     | `authorization.spec.ts`; `auth.http.test.ts`, `permissions.postgres.test.ts`; journey (paso 10: ADMIN lee sin permisos de factura, sin escritura); al cambiar de identidad (A→B) no se muestra la caché de A: `late-responses.ui.test.tsx` |
| G06 | React crea, lista y lee factura persistente                                                                                                                                              | journey (paso 5); `invoices-create.spec.ts`, `invoices-profile.spec.ts`                                                                                                                                                                    |
| G07 | React emite token con secreto visible una vez                                                                                                                                            | journey (paso 6); `api-tokens.spec.ts`; `api-tokens.postgres.test.ts`                                                                                                                                                                      |
| G08 | Swagger Authorize usa Bearer operacional                                                                                                                                                 | journey (paso 7, contexto sin cookie); `swagger.spec.ts` (incluye «nunca envía la cookie»)                                                                                                                                                 |
| G09 | Try it out POST devuelve 201 contractual                                                                                                                                                 | journey (paso 7); `swagger.spec.ts` (201, replay y 409); `invoice-create.contracts.test.ts`                                                                                                                                                |
| G10 | Swagger consulta; React refrescado muestra la misma factura                                                                                                                              | journey (paso 7)                                                                                                                                                                                                                           |
| G11 | curl y Python crean con clave de idempotencia                                                                                                                                            | journey (paso 8); `example-clients.clients.test.ts` (`pnpm test:recovery:clients`)                                                                                                                                                         |
| G12 | Filtros y eliminación respetan los cuatro permisos independientes                                                                                                                        | journey (pasos 5 y 9); `invoices-profile.spec.ts`; `invoice-read.postgres.test.ts`, `invoice-delete.postgres.test.ts`, `invoice-permissions.unit.test.ts`                                                                                  |
| G13 | Otras organizaciones y grupos bloqueados, en sesión y Bearer                                                                                                                             | `authorization.spec.ts`; `invoice-bearer.postgres.test.ts`, `invoice-read.postgres.test.ts`, `api-tokens.postgres.test.ts`                                                                                                                 |
| G14 | Revocar en React bloquea inmediatamente siguientes usos                                                                                                                                  | journey (paso 11: Swagger y ambos clientes en 401); `api-tokens.spec.ts`; `swagger.spec.ts`; token revocado, vencido o con la membresía perdida en la siguiente petición Bearer: `invoice-bearer.postgres.test.ts`                         |
| G15 | Todo lo anterior con MLflow/Model API/blockchain OFF                                                                                                                                     | journey (paso 12: auditoría de red de cada contexto, `apps/e2e/support/network.ts`); `swagger.spec.ts`; `no-outbound.unit.test.ts` (sin clientes HTTP ni sockets en `apps/backend/src`, dependencias de runtime revisadas)                 |
| G16 | Panel Admin: usuario sin organización, edición, reset con temporal una vez, membresías y permisos                                                                                        | journey (paso 1); `admin-users.spec.ts`; `admin-users.postgres.test.ts`, `admin-user-directory.postgres.test.ts`                                                                                                                           |
| G17 | Permisos por usuario en organización y grupo; ADMIN y administrador de plataforma solo leen facturas por rol (escritura sigue por permisos); cambios efectivos en la siguiente solicitud | journey (pasos 3, 5 y 10); `permissions.postgres.test.ts`, `invoice-bearer.postgres.test.ts`                                                                                                                                               |
| G18 | Facturas en alcance organización o grupo: alta, lista, detalle, eliminación e idempotencia por alcance                                                                                   | journey (pasos 5, 7, 8 y 9); `invoices-create.spec.ts`; `invoice-create.postgres.test.ts`, `invoice-read.postgres.test.ts`, `invoice-delete.postgres.test.ts`                                                                              |
| G19 | Modo oscuro: sigue el sistema, override persistido, contraste en ambos temas                                                                                                             | journey y toda la suite en el proyecto `desktop-dark`; `navigation.spec.ts` (alternancia persistida); `theme.ui.test.tsx`, `theme-bootstrap.ui.test.ts`, `theme-contrast.ui.test.ts`                                                       |
| G20 | Organización editable, resumen con conteos, «Administrar miembros/grupos» y ficha básica solo con organización compartida                                                                | `admin-users.spec.ts`, `organizations.spec.ts`, `screens.spec.ts`; `organizations.postgres.test.ts`, `organization-directory.postgres.test.ts`                                                                                             |

## Secretos en los artefactos

- Las pruebas que muestran una contraseña temporal o un token (`journey`,
  `admin-users`, `admin-wizard`, `member-creation-secret`, `api-tokens`,
  `swagger`) apagan la captura y la traza de fallo.
- El teardown global borra el snapshot de página de sus fallos.
- El recorrido verifica que ninguna página ni la salida de los clientes
  conserven el secreto.
- Las capturas de `apps/e2e/e2e-artifacts/` y `test-results/` pueden contener las
  credenciales desechables de la base de pruebas; están ignoradas por git.
