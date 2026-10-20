# MLFLOW-07 — evidencia operacional local

**2026-10-20: COMPLETED_LOCAL_VALIDATED.** El responsable ejecutó la prueba
aislada; el verificador independiente respaldó los cinco criterios originales.
Este informe conserva su evidencia sanitizada, sin publicar checkpoints privados
ni convertir el resultado en despliegue o preparación productiva. La actualización
documental no vuelve a ejecutar el runtime.

## Cierre final con código remediado (2026-10-20)

**Nueva prueba PASS, separada del PASS histórico inferior:** checkpoint opaco
`147273ec3819672ab9fd67b6`, `prepare → prepare-images` explícito
`→ images-ready → start` sólo caché `→ prove → cleanup`, estado `cleaned`,
runtime `passed`. El responsable ejecutó PostgreSQL **16.9**, MLflow **3.16.1**,
Prisma y sesiones HTTP reales de `createApp`, **957 assertions en cuatro fases**;
incluyen chunks HTTP, no 957 tests independientes. La tabla histórica de cinco
operaciones inferior se confirmó nuevamente: planificado = confirmado en todas
sus columnas, incluida repetición cero, seis revocaciones/seis retiradas y cero
mutaciones finales. No se ejecutó `server.ts` ni un full-stack productivo.

La auditoría independiente fresca de recibos sanitizados y metadata Docker local
de sólo lectura verificó el éxito y la nueva preparación fallida
`642a7929350b5bbeb94e3ce2`: **0 contenedores/redes/volúmenes/imágenes propios por
nonce**, **0 contenedores/redes/volúmenes del proyecto**. El intento fallido
conserva `COMMAND_FAILED`, causa **UNKNOWN** y `cleaned_unverified` con fallo;
la ausencia auditada no reescribe ese estado. No hay causa de registro demostrada;
los diagnósticos nuevos no prueban corregida su causa raíz.

Los **44 contenedores, 15 redes, 54 volúmenes y 85 IDs de imágenes** basales
permanecían presentes: no acredita invariancia de estado. Las imágenes públicas
compartidas cacheadas se preservaron; la base Python no estaba en el inventario
basal y ahora está cacheada, sin propiedad del checkpoint. **Cero imágenes propias
retenidas** no significa que se retiraran todas las imágenes nuevas. Checkpoints
privados con secretos sintéticos retenidos intencionalmente, no publicables.

**Gates finales recibidos, no repetidos por este escritor documental:** backend
**343/343 PASS**, 34 archivos, 4.563 s, una corrida final fresca con configuración
externa `envDir: false` sin dotenv y tests predeterminados salvo integración;
focalizadas **66/66 PASS, 595 ms**. Tipos producción/pruebas, generación Prisma y
build backend con emisión frescos después de CR-019, lint raíz y formato dirigido
de código/pruebas/arnés **PASS**. Guardas Node **16 + 3 + 13 PASS**; las 13 guardas
VM ejercitan el driver real en fronteras sustituidas, no Docker real. Stack
**124/124 PASS**, sin skips, 16.893 s unittest/17.179 s proceso: adaptador en memoria
con 37 consultas reales Compose config y una de versión exacta, configuración
anónima sin motor/servicios. Hashes funcionales intactos durante gates; whitespace
App/Stack y no rastreados PASS. Frontend conserva tipos/build anteriores no repetidos.

CR-013/014/015/016/017/018/019/030 quedan **RESOLVED_LOCAL_VERIFIED** según el
[ledger final](../../../../../dev/tickets/Implementado.md#cierre-final-de-remediación-local--cr-013-a-cr-019-y-cr-030-2026-10-20).
La revisión independiente del último arreglo de caché respalda CR-030; la nueva
revisión de CR-019 respalda el cierre independiente de borrado/cierre. CR-017
resuelve mitigación, no la causa del timeout histórico de 7599 ms (**UNPROVEN**).
CR-013 usa reloj virtual hasta 1800 s, no una ejecución real de esa duración.
Los strings inmutables no permiten garantizar borrado total; permanece TOCTOU
entre fuente académica y proveedor. Launcher, keep-alive, distribución y remoto
siguen **NOT_VERIFIED**. Sin tickets adicionales, servicios ni reruns en esta edición.

## Resultado y criterios históricos

> Se conserva el PASS anterior, sus tres fallos y verificaciones originales sin
> reclasificación. Para los bytes remediados y la nueva preparación fallida,
> prevalece el cierre final superior; los comandos por etapas siguientes son vigentes.

Entorno probado: Docker **27.4/aarch64**, Compose **2.31.0**, PostgreSQL **16.9**
y MLflow **3.16.1**, sólo localhost, con cuentas sintéticas y archivo secreto
externo `0600`. El arnés usa HTTP real de `createApp`, autenticación de App y
Prisma real; **no usa el launcher `server.ts`**.

| Criterio original              | Evidencia local                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Crea Workspace de organización | Dos organizaciones con un Workspace nuevo cada una.                                               |
| Crea usuarios necesarios       | Tres cuentas nuevas en la primera organización y una en la segunda.                               |
| Crea roles de grupos           | Roles y recursos canónicos; adopción autoritativa de roles legados.                               |
| Asigna memberships             | Asignaciones verificadas y escrituras permitidas/denegadas sobre Experiments y Registered Models. |
| Repetir no duplica             | Segunda ejecución y repetición posterior a revocación con cero mutaciones.                        |

Checkpoint opaco aprobado: `40704caecb08bba74436550c`, secuencia
`start → proved → cleaned`, runtime `passed`. Sus cuatro fases fueron
`version-and-auth`, `dry-run-create-and-access`,
`idempotence-and-password-preservation` y `revoke-and-preserve`.
**957 assertions incluyen chunks de cuerpos HTTP: no son 957 tests independientes.**

Las cinco operaciones reales conciliaron **planificado = confirmado** en cada
columna; los ceros son ausencia de mutaciones, no omisión de verificaciones.

| Operación            | Workspace | Usuario | Experiment | Modelo | Rol | Grant nuevo | Asignación | Revocación de grant | Retirada de asignación |
| -------------------- | --------- | ------- | ---------- | ------ | --- | ----------- | ---------- | ------------------- | ---------------------- |
| Crear organización A | 1         | 3       | 6          | 6      | 8   | 14          | 12         | 0                   | 0                      |
| Crear organización B | 1         | 1       | 1          | 1      | 3   | 4           | 2          | 0                   | 0                      |
| Repetir              | 0         | 0       | 0          | 0      | 0   | 0           | 0          | 0                   | 0                      |
| Revocar/reconciliar  | 0         | 0       | 0          | 0      | 0   | 0           | 0          | 6                   | 6                      |
| Repetir tras revocar | 0         | 0       | 0          | 0      | 0   | 0           | 0          | 0                   | 0                      |

También se comprobaron aislamiento entre grupos/Workspaces, degradación
administrativa, baja de membership, grupo eliminado y revocación; preservación
de grants directos, roles independientes y administradores globales; contraseña
existente sin reset; dry-run sin cambios; rechazos de autenticación/autorización
`401/403`, CSRF y límite `429`.

Sólo se adelantó el reloj del cooldown de provisioning. Los límites de **5 s
por llamada y 60 s globales permanecieron reales**. Las conexiones HTTP frescas
(`Connection: close`) aíslan el reinicio del listener de fixture; la inspección
es serial y el diagnóstico usa `AsyncLocalStorage`.

## Reproducción acotada, no ejecutada por esta actualización

Desde `apps/v2`, con dependencias ya disponibles y autorización
expresa para el socket Docker local y recursos nuevos exclusivos. El driver
está acotado al entorno/arquitectura/versiones anteriores; no es un launcher
portable ni permiso para instalar, descargar o reutilizar servicios existentes.
Rechaza configuración Docker ambiental y no carga `.env`.
CR-030 separa ahora la preparación de imágenes del arranque: `start` nunca
construye ni descarga, aunque falte una imagen o exista caché de pip/build.

```bash
node invoiceops-app/apps/backend/scripts/mlflow07-proof-guards.mjs
node invoiceops-app/apps/backend/scripts/mlflow07-proof.mjs guard-requests
node --experimental-vm-modules --test invoiceops-app/apps/backend/scripts/mlflow07-proof-network-guards.mjs
node invoiceops-app/apps/backend/scripts/mlflow07-proof.mjs prepare
```

Las guardas originales conservan **16 casos** y `guard-requests` **3 casos**,
sin proveedor; sí emplean HTTP sintético loopback. Las guardas de red sustituyen
únicamente fronteras de filesystem/proceso/socket y no ejecutan Docker real.
`prepare` genera un checkpoint nuevo y estado privado separado, sin arrancar
servicios. Copiar sólo su ID opaco
al marcador `CHECKPOINT_ID`; no copiar contraseñas, nonce, archivos privados ni
IDs de entidades a argumentos o documentación. No reutilizar el checkpoint
histórico ya limpiado.

```bash
node invoiceops-app/apps/backend/scripts/mlflow07-proof.mjs config-check CHECKPOINT_ID
```

**Punto de autorización separado:** sólo después de aprobar expresamente red,
descargas públicas, consumo de disco/caché y build con pip, ejecutar:

```bash
node invoiceops-app/apps/backend/scripts/mlflow07-proof.mjs prepare-images --allow-downloads CHECKPOINT_ID
```

Esta etapa admite únicamente las referencias públicas fijadas de PostgreSQL,
MinIO/MC, Python y la receta MLflow fijada con dependencias pip. Consulta primero
el listado local por referencia exacta y exige que su ID completo coincida con
`image inspect`. Sólo una ausencia confirmada permite descargar esa referencia;
errores del motor, metadatos ambiguos o identidades distintas detienen la etapa,
sin fallback a red. Con las cuatro entradas en caché no ejecuta ningún `pull`.
Reutilizar IDs del motor local confiable no acredita procedencia criptográfica,
frescura del registro ni una preparación completamente offline: el build explícito
todavía puede necesitar red para resolver la base o instalar dependencias pip.
Siempre construye la imagen propia con nonce nuevo, aunque reutilice capas. Usa el
contexto hermano y su `.dockerignore` permitido, configuración Docker anónima,
deadline de 10 minutos y comandos acotados. Registra el inventario previo, una
imagen MLflow con etiqueta y label únicos por checkpoint/nonce y los cinco IDs
requeridos. No crea volúmenes, redes ni contenedores. Un build fallido no habilita
el arranque; conservar el checkpoint para revisión, sin repetir ni limpiar a ciegas.

Los fallos de preparación conservan `preparationFailure` con sólo `step`,
`category` y `semanticCategory` permitidos. Distinguen `cache-postgres`,
`pull-postgres`, `pull-minio`, `pull-minio-init`, `pull-python`, `build-mlflow`
y las verificaciones posteriores, sin URL, argumentos ni logs de build. Una
categoría semántica es una pista acotada, no una causa raíz demostrada. Para
consultar únicamente la proyección segura del checkpoint, sin Docker:

```bash
node --input-type=module -e 'import { preparationStatus } from "./invoiceops-app/apps/backend/scripts/mlflow07-proof.mjs"; console.info(JSON.stringify(preparationStatus(process.argv[1])));' CHECKPOINT_ID
```

Los intentos anteriores sin ese diagnóstico siguen siendo de causa desconocida;
esta corrección no reescribe sus checkpoints ni convierte sus fallos en PASS.

Una vez alcanzado `images-ready`, con autorización propia de ejecución local:

```bash
node invoiceops-app/apps/backend/scripts/mlflow07-proof.mjs start CHECKPOINT_ID
node invoiceops-app/apps/backend/scripts/mlflow07-proof.mjs prove CHECKPOINT_ID
node invoiceops-app/apps/backend/scripts/mlflow07-proof.mjs cleanup CHECKPOINT_ID
```

Cada etapa se decide por separado. `config-check` sólo valida configuración;
`start` exige los cinco IDs locales exactos antes de mutar recursos y usa
`up --no-build --pull never`: una imagen ausente/cambiada o propiedad inválida
falla sin descarga ni limpieza automática de preflight. Crea recursos nuevos,
`prove` hace escrituras reales sobre la fixture y
`cleanup` retira exclusivamente recursos propios exactos. Ante fallo, conservar
el recibo y auditar el estado antes de decidir limpieza o nueva ejecución; nunca
repetir una mutación incierta a ciegas. Tras iniciar mutaciones de recursos runtime,
el driver intenta limpieza acotada también en error, conserva el fallo y no hace
`prune` global. Una ejecución nueva no reescribe el resultado anterior.

Archivos del arnés: `scripts/mlflow07-proof.mjs`,
`scripts/mlflow07-proof-guards.mjs`, `scripts/mlflow07-proof-network-guards.mjs`
y `test/runtime/mlflow07-live.ts`, relativos a
`apps/backend`. Los checkpoints privados retenidos contienen **secretos
sintéticos** y no deben publicarse, adjuntarse ni imprimirse completos. No se
usaron credenciales reales. Este informe no expone sus ubicaciones privadas.

## Intentos fallidos preservados — no PASS

| Checkpoint opaco           | Resultado original y diagnóstico permitido                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `954b6b6b6a17e8d337ea5dc1` | Fallo en fase de autenticación; diagnóstico inicial insuficiente, causa raíz no determinada.                                                                                                                                            |
| `d4af39ee517aaa48ae4958e4` | Primer login: `CONNECTION_RESET` al reiniciar el listener con pool de fixture. Reproducción: 20/20 fallos con la ruta anterior y 20/20 PASS con conexiones nuevas; corrección limitada a la fixture.                                    |
| `7cf35f9941269b3103ecf918` | Timeout durante revocación; causa raíz **UNPROVEN**. Se eliminaron inspecciones paralelas y contexto diagnóstico mutable compartido mediante inspección serial y `AsyncLocalStorage`; esto no prueba una causa del proveedor corregida. |

No se agregan estos fallos al PASS final ni se los sustituye por una repetición
agregada. Se conservaron su evidencia de fallo y la limpieza por checkpoint.

## Verificación independiente y limpieza

El verificador del **2026-10-20** ejecutó guardas frescas **16 + 3 PASS** e
inspección Docker de sólo lectura para las cuatro ejecuciones. En cada una:
**0 contenedores, redes, volúmenes e imágenes propios por nonce** y **0
contenedores/redes/volúmenes del proyecto exclusivo**. No se publican nombres ni
IDs de recursos ajenos.

Todos los IDs del inventario basal permanecían presentes: **44 contenedores,
15 redes, 54 volúmenes y 85 imágenes**. Esto acredita **presencia**, no invariancia
global de estado, configuración, contenido o ejecución de recursos ajenos. La
destrucción autorizada se limitó a recursos nuevos de propiedad exacta; los
checkpoints privados se retuvieron intencionalmente, no se consideran borrados.

Producción no cambió al corregir el arnés: se conservan los gates anteriores
del responsable (**320/320 backend en 34 archivos**, **47/47 focalizados**,
ESLint, generación Prisma, typecheck de producción/pruebas, build y whitespace
PASS). El último escritor verificó tipos/lint/formato del arnés. Las guardas
frescas del verificador no equivalen a repetir la suite funcional o el runtime
completo. No se requiere una nueva suite sobre producción sin cambios por este
cierre exclusivamente documental.

## Límites y continuidad

**NOT_VERIFIED:** launcher `server.ts`, pool/keep-alive de producción,
coordinación distribuida/réplicas, carrera adversarial real del filesystem,
proveedor remoto y preparación productiva. No se completan STACK-03/04/08,
INT-06 ni despliegue App. No hay evidencia de una transacción distribuida ni
rollback automático; deshabilitar provisioning no revierte efectos existentes.

MLflow queda **7/9 (77.8%)**. MLFLOW-06 y MLFLOW-08 permanecen pendientes y
remotos diferidos. El [cierre central y siguiente propuesta](../../../../../dev/tickets/Implementado.md#mlflow-07--cierre-operacional-local-2026-10-20)
mantiene los demás conteos y bloqueos; no autoriza iniciar otro trabajo.
