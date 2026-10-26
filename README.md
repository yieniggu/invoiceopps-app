# InvoiceOps App

> **Bootstrap transversal:** consulte el
> [runbook central de Stack](../invoiceops-stack/LOCAL_INFRASTRUCTURE_RUNBOOK.md)
> antes de iniciar un entorno local limpio. Este README es propietario de App,
> Prisma, Evidence y reconcile; sus recetas de componente no sustituyen la
> validación integrada ni habilitan operaciones remotas (`NOT_VERIFIED`).

## Remediación FULLAPP12 — CR009, CR010 y CR011

**CR009, CR010 y CR011: RESOLVED_LOCAL_VERIFIED (2026-10-22).** Cierre acotado de
los tres hallazgos con inspección interna independiente, pruebas y QA nativa
recibida sobre la fuente congelada actual de **61 archivos**, fingerprint `d45...`.
No es una revisión formal nueva, aprobación humana ni certificación productiva.
Frontend final **335/335**; 330/330 queda histórico. Backend **94/94** y SQL **74/74**
se reutilizan porque backend/API/schema no cambiaron tras el último delta frontend;
no son ejecuciones nuevas de este cierre documental. El cierre S8 y sus 65 layouts
son históricos, no prueba de estos bytes. APP-12 no recibe crédito adicional;
APP-13 está **CLOSED / COMPLETED_LOCAL_VALIDATED**. CR001–CR008 y CR005 humano
solo para S1 permanecen intactos.

- **CR009:** PATCH solo fusiona `email`/`username` confirmados del mismo actor,
  nunca roles ni membresías. Las lecturas de capacidades usan una revisión
  monotónica separada del epoch. Un refresco administrativo conserva el borrador
  de contacto y los ledgers Policy/Invoice/Admin.
- **CR010:** un ADMIN organizacional elige una organización en **Mis grupos →
  Catálogo administrativo de grupos** y gestiona grupos sin ser integrante. Carga
  diferida/paginada, cinco mutadores existentes, integrantes no consultados
  indicados expresamente y control por UUID existente, sin directorio personal.
  El catálogo nunca aporta propietarios a Workspace; los solapamientos se deduplican.
- **CR011:** lock sincrónico por destino; creación incierta bloquea nuevas creaciones
  en esa organización. Red/5xx requieren verificación operativa, no reenvío. Una
  lista o nombre coincidente no confirma la creación. 4xx permite corregir; 2xx
  conserva confirmación aunque falle el refresco y habilita solo reintentar lecturas.
  DELETE204 no se interpreta como JSON. El ledger conserva intención/cuerpo y
  bloqueos al navegar/logout fallido; nueva sesión lo limpia y aísla callbacks viejos.
  Un único helper recorta espacios del UUID de integrante antes de construir
  cuerpo, ruta y clave ADD/REMOVE, conservando el borrador escrito y las
  mayúsculas/minúsculas. La solicitud usa la intención canónica del ledger.
  Dos integrantes distintos conservan alertas independientes con clave React
  única y UUID visible; las lecturas de catálogo/MyGroups no liberan unknown.

### Evidencia de cierre y alcance

El coordinador aportó Chrome **155** → Nginx **1.27.5** → Node **24.21.0** →
PostgreSQL propio **17.11**, con 13 migraciones, auth/dominio/SQL nativos. Solo las
fronteras Model API/MLflow se sustituyeron y no se usaron en estos flujos:

- **CR009:** PATCH real confirmado en SQL, cuerpo ADMIN antiguo retenido antes
  de consumirlo en JS, autorretirada organizacional y liberación del cuerpo sin
  restaurar membresías/roles. Recursos/Evidencia no enviaron consultas privadas.
- **CR010:** ADMIN organizacional no integrante y no plataforma ejercitó los cinco
  mutadores nativos y sus resultados SQL; autorretirarse del grupo conservó su
  administración en catálogo, no un owner de Workspace. Consulta privada forzada
  denegada 404; privacidad/paginación y casos de rol cubiertos también por SQL74.
- **CR011:** commit real seguido de pérdida de headers sin POST duplicado tras
  navegar/consultar y logout503 interceptado antes de revocar la sesión. Dos
  integrantes distintos se confirmaron una vez cada uno; alias con espacios y
  DELETE del roster quedaron bloqueados, con dos alertas UUID independientes.

Se conservan dos fallos del arnés: esperar ADD habilitado tras remount con campo
vacío y exigir DPR absoluto 2 cuando el zoom nativo produjo DPR4. La continuación
cierra los flujos funcionales; un suplemento **solo geométrico**, HTTP sintético
DIRECT loopback, acredita zoom relativo 200% en dos anchos lógicos (1280→640 y
768→384 CSS, DPR2→4, CSS zoom1), no nueva prueba de auth/SQL. Layout recibido:
6 perfil/confirmación al 100% + 3 grupos al 100% + 2 grupos al 200%; no una matriz
global única ni los 65 casos S8 repetidos. Teclado Enter/Tab con foco inicial DOM;
sin certificación de lector de pantalla, popup nativo ni nueva comparación V1.

Gates conservados: focal **112/112**, tipos/lint/build Vite sin envDir/formato/diff
PASS; spot independiente **14/14 en 2.34 s**, subconjunto de 335, y cuatro configs
tsc de paquete PASS. SQL74 son ocho suites reales (71 previas + tres de catálogo),
mediante adaptador de `spawn` hacia herramientas instaladas, no pnpm ni SQL simulado.
Cada fase nativa verificó cleanup **5/5** (tres contenedores/dos redes) y Chrome0;
el suplemento geométrico creó cero recursos Docker y cerró Chrome/servidor.
Este escritor solo concilia documentos y comprueba hashes/formato/diff, sin replay.

El ledger solo vive en memoria: recargar pierde la protección, **no** cancela
efectos ni proporciona idempotencia del servidor. Logout legítimo sigue disponible.

### Catálogo: contrato mínimo

`GET /organizations/:organizationId/groups?limit=50&cursor=<group-uuid>` requiere
sesión y ADMIN vigente de esa organización o singleton plataforma. `limit` escalar
entero **1–100**, default **50**; IDs/cursor UUID, sin duplicados/objetos/campos
desconocidos. Orden `name,id`, cursor ligado a organización. DTO
`{groups:[{id,name,description,organization:{id,name}}],nextCursor:string|null}`,
`Cache-Control: no-store`, sin integrantes/RUT/email. Sesión ausente 401, estudiante
403, organización inaccesible/inexistente/cursor ajeno 404, entrada inválida 400.
`GET /groups` sigue **solo mis membresías**, única fuente de grupos de Workspace.
Sin schema, índices, migraciones, dependencias ni ampliación de proxy.

El [registro de remediación](../dev/tickets/Implementado.md#fullapp12--remediación-cr009-cr010-y-cr011)
conserva RED/GREEN, fallos de arnés, procedencia SQL/nativa, fingerprint y hashes
intactos. No acredita launcher/build de imagen oficial, CI, TLS, despliegue,
proveedores vivos ni cadena. Sin commit, push ni nuevo trabajo funcional.

Aplicación académica InvoiceOps: backend Express con TypeScript, frontend React
con Vite y PostgreSQL. APP-12 está **CLOSED / COMPLETED_LOCAL_VALIDATED** en su
contrato de interfaz aprobado. APP-13 está **CLOSED / COMPLETED_LOCAL_VALIDATED**
para CI e imágenes Docker locales; ninguno de los dos cierres implica publicación,
despliegue ni ejecución remota del workflow.

## Interfaz en español — APP-12 / S8

**Estado: CLOSED / COMPLETED_LOCAL_VALIDATED (2026-10-22). S1–S8 completos en
alcance local.** Las doce superficies y los cinco criterios originales tienen
evidencia de fuente, automatización, recorrido nativo y comparación visual V1/V2.
El [cierre global y sus límites](../dev/tickets/Implementado.md#app12s8--cierre-global-local-validado-2026-10-22)
es la referencia autoritativa; los hitos anteriores conservan su procedencia.

La prueba local ejercitó Chrome 155 → Nginx **1.27.5** → Node **24.21.0** →
PostgreSQL **17.11** con Prisma y las 13 migraciones existentes, en recursos propios
aislados. Auth, autorización y servicios de dominio fueron nativos; solo Model API
y el lector MLflow externos se sustituyeron. Nginx usó la configuración exacta del
repositorio y los assets congelados. Hubo **65/65 observaciones de layout en dos
tramos**, cubriendo doce grupos de superficies de acceso y trabajo, y un suplemento dirigido
**4/4 PASS**; no fue una única ejecución global sin fallos. Los tres fallos de
assertions del arnés anterior se conservan junto con su explicación y prueba posterior.

El tag `node:24-alpine` no estaba disponible: se utilizó Node 24.21.0 de una imagen
backend del mismo proyecto ya cacheada, con módulos/dependencias actuales montados
en solo lectura, sin ejecutar el launcher antiguo. Esto acredita composición nativa
local, **no** build de la imagen oficial, bootstrap productivo, CI, TLS, despliegue
ni proveedores ML reales. Esos alcances no se certifican con APP-12.

La comparación con plantillas/CSS reales de V1 respalda mejoras de orientación,
español, contexto y explicación de estados. V1 ya tenía responsive, foco y tablas
con scroll. Como mejora opcional no bloqueante queda reducir la densidad de la
navegación móvil y la repetición de contexto, preservando teclado y estado activo;
no se implementa aquí. No se afirma aprobación estética humana, certificación WCAG,
lector de pantalla real ni compatibilidad funcional completa del backend V1.

### Recorrido de trabajo

1. Inicia sesión con las credenciales entregadas por un administrador global.
   No existe registro público. Una cuenta provisionada recibe una contraseña
   temporal y debe cambiarla antes de acceder a la aplicación. La sesión usa una
   cookie; no copies tokens al navegador.
2. En **Mi perfil**, consulta identidad y membresías y guarda correo electrónico
   o nombre de usuario. Nombre, RUT y roles no se editan allí.
3. En **Organizaciones**, elige una membresía vigente; en **Mis grupos**, usa
   **Trabajar con…** para seleccionar un grupo al que perteneces. El resumen de
   organización/propietario permanece visible al navegar. Si el acceso se revoca,
   no se elige otro propietario automáticamente.
4. Desde **Panel principal**, abre el trabajo deseado. El panel muestra contexto
   y accesos, no totales financieros o métricas que la API no ofrece.
5. En **Facturas**, busca por ID/proveedor y carga más resultados explícitamente.
   **Ver…** abre el **detalle de factura**, sus hechos, riesgo y auditoría.
   **Evaluación ML** permite aplicar Regla v1 o una versión existente de política:
   la acción decide y persiste en el servidor, no es una simulación.
6. En **Políticas**, consulta versiones/umbrales del mismo propietario. El dueño
   individual puede crear/editar; las políticas grupales requieren ADMIN de esa
   organización. Una probabilidad mayor o igual al umbral deriva a revisión manual.
   Escribe la versión elegida en Evaluación ML; no se aplica automáticamente.
7. En **Recursos**, distingue referencias de InvoiceOps de metadatos de MLflow.
   Los enlaces abren otra aplicación con autenticación independiente. Nombres,
   IDs y versiones reales se conservan; aliases, estados, métricas, parámetros y
   etiquetas no están expuestos por el DTO actual y no se inventan.
8. En **Evidencia y lotes**, filtra registros por UUID, abre un detalle o lote y
   solicita la prueba de un miembro. Es solo lectura: no crea lotes, firma,
   transmite ni consulta blockchain. La integridad se verifica en el servidor;
   no es criptografía independiente del navegador ni acredita finalidad.
9. **Administración** aparece solo para administradores de organización o
   plataforma. El primero gestiona grupos desde Mis grupos; solo plataforma
   crea organizaciones, provisiona usuarios con rol inicial y gestiona
   membresías. La contraseña temporal se muestra una sola vez y no se registra.
   Descubrir una organización administrable no concede acceso a su trabajo.

Son las doce superficies del ticket: acceso mediante login,
perfil, organizaciones, grupos, panel, facturas, detalle, políticas, evaluación,
recursos, evidencia/lotes y administración. No son doce destinos universales:
detalle/evaluación se abren dentro de Facturas y Administración depende del rol.

### Estados, incertidumbre y límites

- Carga, vacío, validación y errores tienen mensajes en español y reintentos
  deliberados. Un 401 vigente retira la sesión; datos tardíos de otro contexto o
  sesión no deben publicarse. Los errores no muestran cuerpos crudos del proveedor.
- Navegar no cancela una escritura recibida por el servidor. Ante resultado
  desconocido no reenvíes a ciegas: en facturas consulta el estado; en políticas
  consulta una versión/umbral coincidentes mediante una lectura posterior al
  error. Que una factura siga pendiente no prueba cancelación de la solicitud.
  En administración no existe lookup del destinatario: el resultado desconocido
  permanece bloqueado y requiere verificación autoritativa fuera de esa vista.
- Los registros de operaciones viven solo en memoria de sesión/navegación.
  Recargar pierde esos bloqueos; una nueva sesión no reconcilia efectos anteriores
  ni aporta idempotencia. Un cierre de sesión fallido conserva la incertidumbre.
- Recursos MLflow consulta cada 15 s únicamente montado y visible, con una
  solicitud activa hasta completar JSON. Ocultar pausa/aborta; volver reanuda;
  salir detiene el polling. Un 500 puede conservar datos anteriores del mismo
  contexto con aviso; 403/404 los retiran y 401 vigente detiene la consulta.
- Facturas y evidencia usan páginas de 50 por defecto, máximo API 100; la UI de
  evidencia pide 50, sin lectura automática de todas las páginas. Un lote admite
  hasta 256 hojas. MLflow devuelve hasta 25 ejecuciones y 25 versiones y señala
  truncamiento. Los detalles y pruebas se consultan bajo acción explícita.
- Regla v1 conserva monto hasta 500000 centavos, orden de compra y cotejo de tres
  vías. La política, auditoría y evidencia se resuelven en backend; si la
  inferencia falla, el respaldo es revisión manual sin probabilidad inventada.

### Configuración, activación y reversión del lote

Prepara configuración solo en el entorno privado del backend, sin imprimirla ni
copiarla a `VITE_*`. El frontend usa rutas del mismo origen; el backend conserva
cookie httpOnly, control Origin/CSRF y autorización actual en cada operación.
Los ejemplos de instalación e infraestructura posteriores son guía general,
no instrucciones ejecutadas ni autorizadas por la validación S8.

Orden de activación documentado, **no ejecutado**: verificar compatibilidad del
esquema existente APP-03–11 sin migraciones S8; desplegar primero el backend con
las cinco lecturas aditivas S6 (`GET /evidence-records`, `/:id`,
`GET /evidence-batches`, `/:id`, `/:batchId/proofs/:recordId` bajo su namespace);
después publicar frontend y proxy Vite/Nginx coherentes para políticas, evidencia
y membresías. Comprobar cookie/Origin, propietario individual/grupal, perfiles
STUDENT/ADMIN/plataforma, errores y una versión de política codificada en la URL.
APP-13 (CI e imagen Docker) no se implementa en este lote. La publicación y el
despliegue requieren su autorización separada y mantienen el diferimiento vigente.

Para rollback, recuperar un artefacto anterior conocido del **lote coherente** de
aplicación y proxy, conservando cambios ajenos y datos; no usar reset del árbol de
trabajo ni borrar archivos del usuario. Revertir código no deshace decisiones,
políticas, membresías, auditoría o evidencia persistidas. No ejecutar downgrade,
reset de DB, borrado de volúmenes ni reenvío de transacciones/wallets como rollback.
La retirada del frontend no cancela operaciones ya recibidas por el servidor.

## Aprovisionamiento académico de MLflow — MLFLOW-07

**COMPLETED_LOCAL_VALIDATED (2026-10-20):** implementación local validada con
PostgreSQL 16.9, MLflow 3.16.1, Prisma y HTTP real de `createApp`; los cinco
criterios originales tienen respaldo independiente. MLflow: **7/9 (77.8%)**.
La [evidencia y reproducción por etapas](apps/backend/test/runtime/MLFLOW07_PROOF.md)
preserva los tres intentos fallidos y el PASS anterior, además del cierre fresco
`147273ec3819672ab9fd67b6` y la preparación fallida `642a7929350b5bbeb94e3ce2`;
no acredita el launcher
`server.ts`, despliegue App ni preparación productiva.
`POST /admin/mlflow/provision` requiere sesión válida, CSRF del backend y el
administrador de **plataforma** vigente. Un `ADMIN` de organización no puede
invocar esta operación. El JSON admite exclusivamente `organizationSlug` y el
booleano obligatorio `dryRun`, sin normalizar el slug ni aceptar identidades,
URLs o credenciales del solicitante. La autorización se vuelve a comprobar en
PostgreSQL antes de consultar al proveedor.

### Configuración explícita y credenciales nuevas

La función está deshabilitada por defecto. La composición sólo admite
`MLFLOW_PROVISION_MODE=local-development`, `NODE_ENV=development` y una URL HTTP
en loopback literal (`127.0.0.1` o `[::1]`), sin path, usuario, query ni fragmento.
No se permiten nombres DNS, redirects, HTTPS remoto ni habilitación implícita.
Los nombres de configuración son:

- `MLFLOW_PROVISION_URL`: origen local de MLflow.
- `MLFLOW_PROVISION_USERNAME` y `MLFLOW_PROVISION_PASSWORD`: identidad
  administrativa separada del lector `MLFLOW_READ_*`; no se amplían sus permisos.
- `MLFLOW_PROVISION_SECRETS_FILE`: ruta absoluta y canónica a un archivo JSON
  local **fuera del repositorio real**, preparado y entregado privadamente por
  el operador. Sus claves son RUT normalizados y sus valores son contraseñas
  aleatorias distintas de entre 12 y 256 caracteres, sin saltos de línea ni NUL.

El archivo debe ser regular, del UID que ejecuta el backend, sin symlinks ni
hardlinks, con permisos `0600` o más restrictivos (`0400` es válido), sin bits
especiales ni acceso de grupo/otros. Máximo 64 KiB y 100 entradas. Se verifican
identidad del descriptor y estabilidad del archivo; no se generan archivos ni
credenciales y no existe fallback a `.env`. La aleatoriedad y entrega privada son
responsabilidad del operador; la validación comprueba longitud y unicidad, no
entropía. No incluir secretos en argv, logs, respuestas, notebooks ni Git.

El backend sólo consulta este archivo si la ejecución real necesita crear
cuentas. Deben estar disponibles **todas** sus credenciales antes de la primera
mutación; de lo contrario se rechaza el plan completo. Las cuentas existentes
se reutilizan sin leer su contraseña, resetearla ni cambiar `is_admin`. `dryRun`
no lee el archivo ni realiza escrituras de proveedor o filesystem: informa de
creaciones pendientes, pero no acredita disponibilidad de sus credenciales.

### Namespace autoritativo, adopción y recursos

El Workspace es exactamente `Organization.slug`. Dentro de ese Workspace,
InvoiceOps administra todos los roles `group-<UUID>` y reserva exclusivamente
`invoiceops-base`, `invoiceops-managers` e `invoiceops-owner-<User.id UUID>`.
Los roles de MLflow se identifican por `(workspace, name)` y un ID propio: nunca
se adopta ni modifica un rol de otro Workspace. El nombre define la adopción
según política, **no prueba procedencia histórica**. Un rol manual coincidente
será reconciliado, incluidos permisos incompatibles y asignaciones manuales.

- Base: `(workspace, *, USE)` para miembros de la organización.
- Gestores: `(workspace, *, MANAGE)` sólo para `ADMIN` de organización.
- Propietario individual y grupo: `EDIT` únicamente sobre el ID exacto de su
  Experiment y el nombre exacto de su Registered Model, nunca wildcard `EDIT`.
- Experiments: `student/<RUT>/invoice-risk` y `group/<Group.id>/invoice-risk`.
- Modelos: `student-<RUT>-invoice-review` y
  `group-<Group.id>-invoice-review`, conforme a INT-02/ownership existente.

Se crean o reutilizan esos recursos y roles; no se crean runs, versiones ni el
modelo compartido `invoice-review-production`. No se inventa `created_by_rut`:
los recursos nuevos sólo reciben organización, tipo e ID de propietario. Esto
no simula actividad académica ni satisface por sí solo los filtros de lectura
que requieran creador real. No se borran recursos ni roles cuando desaparece su
propietario: se retiran permisos/asignaciones administradas obsoletas. Una baja
o degradación de rol se refleja en la siguiente ejecución satisfactoria.

Se preservan roles independientes, grants directos, administradores globales y
otros Workspaces. Las asignaciones ya existentes de administradores globales
quedan exceptuadas de la revocación. Los permisos efectivos se acumulan: esta
reconciliación **no elimina accesos independientes** ni convierte el Workspace
en una frontera exclusiva. `USE` conserva la capacidad nativa de crear recursos.

### Límites, fallos y operación

Una ejecución síncrona por proceso; una solicitud por organización/minuto,
incluido dry-run. `409 BUSY` indica ejecución activa y `429 RATE` límite de tasa.
No se admite operación con réplicas ni escritores de provisioning concurrentes.
Si una operación local no cancelable sigue pendiente al vencer el plazo, el
proceso conserva el bloqueo hasta que termine; si no termina, queda fail-closed.
No se añaden infraestructura, dependencias, migraciones ni tablas de ownership.

Límites: 60 s globales; 5 s por llamada; 100 usuarios, 50 grupos, 1000
asignaciones y 2000 llamadas de proveedor. El inventario global de usuarios
tiene también un máximo conservador de 100, incluidos usuarios ajenos y la
cuenta técnica. Los roles existentes y deseados de propietarios/grupos,
incluidos los obsoletos, cuentan para sus límites; máximo 152 roles listados en
el Workspace, 1000 permisos administrados y 1 MiB por respuesta. El archivo de
credenciales y las consultas académicas también están acotados. Inventarios
incompletos, paginados inesperadamente, identidades duplicadas o fuera de scope
se rechazan, sin tomar una primera página como inventario completo. Instalaciones
mayores pueden ser rechazadas de forma conservadora, no reconciliadas a medias.

El plan completo y su presupuesto de llamadas se validan antes de escribir.
La fuente académica se comprueba antes de la primera mutación y de cada grant,
asignación, revocación y retirada. Un cambio detectado detiene con `SOURCE_CHANGED`,
conservando contadores confirmados y efectos desconocidos separados. Las lecturas
se acotan a dos snapshots más uno por cambio de privilegio planificado, con consultas
y deadline limitados. No se mantiene una transacción de DB durante llamadas al
proveedor: persiste TOCTOU entre comprobación y escritura, sin transacción distribuida.

La regex anclada compartida por ruta y error cubre forma canónica, slash final y
mayúsculas/mixtas: JSON malformado/sobredimensionado devuelve 400 seguro y dependencia
503 no filtra detalles; la autorización no cambia. El lector de secretos intenta
borrar buffers en todas las salidas y cerrar el descriptor incluso si falla el
borrado. No se garantiza borrar strings inmutables de memoria.

`200` sólo significa dry-run completo o ejecución completa. Los errores usan
categorías estables (`INPUT`, `LIMIT`, `DISABLED`, `CREDENTIALS`,
`INVALID_PROVIDER`, `SOURCE_CHANGED`, `DEPENDENCY`, `DEADLINE`, entre otras),
sin mensajes crudos del proveedor. Un fallo de dependencia devuelve `502/503`,
incluye contadores agregados de efectos confirmados y `unknownEffects` separado;
una mutación interrumpida o una respuesta inválida **no cuenta como confirmada**.
No hay retry ciego, rollback automático ni atomicidad. No se exponen RUT,
contraseñas, hashes, URLs de proveedor ni IDs de entidades en resúmenes/logs;
la correlación es un UUID aleatorio independiente.

Tras un resultado parcial, el operador debe auditar privadamente los efectos
confirmados y desconocidos antes de decidir una nueva ejecución. Deshabilitar la
configuración y reiniciar el backend detiene futuras solicitudes, pero no
revierte efectos ya aplicados o pendientes en el proveedor. Restauración de
metadata/autorización requiere su procedimiento y autorización separados.

### Evidencia offline, runtime y límites de verificación

Las suites `mlflow-provision*.test.ts` y `mlflow-admin-client.test.ts` ejercitan
el endpoint real con sesiones sintéticas, el plan, reconciliación
crear/repetir/revocar, aislamiento, fallos parciales, límites, timeouts y archivos
temporales sintéticos con cleanup. No usan credenciales reales ni un proveedor
o PostgreSQL real. Ese hito offline fue seguido por la prueba operacional local:
creación/repetición/revocación, aislamiento, preservación de contraseñas y grants
independientes, dry-run y controles HTTP, con **957 assertions** en cuatro fases
(incluyen chunks de cuerpos, no 957 tests independientes). Guardas independientes
frescas finales: **16 + 3 + 13 PASS**. Véase el informe enlazado para contadores y limpieza;
la prueba usa conexiones frescas y no acredita resiliencia del pool productivo.

Contratos inspeccionados: `mlflow/server/auth/{routes.py,client.py,entities.py,
db/models.py,sqlalchemy_store.py}` y `mlflow/store/workspace/rest_store.py` en
el SDK/servidor instalado 3.16.0. Roles RBAC y Workspaces usan API v3; usuarios,
Experiments y Registered Models usan API v2. El requisito mínimo de contraseña
se confirmó además contra el tag exacto
[`v3.16.1`, `utils/validation.py`](https://github.com/mlflow/mlflow/blob/v3.16.1/mlflow/utils/validation.py).
La inspección estática por sí sola no acredita compatibilidad live; la prueba
posterior sólo valida las rutas y permisos ejercitados localmente en 3.16.1.
Remoto, réplicas, launcher productivo y carrera adversarial real del filesystem
siguen **NOT_VERIFIED**. No se repitieron servicios ni suites en este cierre
documental; MLFLOW-06/08 y las dependencias App/Stack siguen pendientes.

**Últimos gates recibidos:** backend 343/343, 34 archivos, 4.563 s en una corrida
final fresca sin dotenv (`envDir: false` externo); focalizadas 66/66, 595 ms;
tipos producción/pruebas, generación y build backend con emisión después de CR-019,
lint raíz y formato dirigido PASS. Frontend conserva PASS anterior, no repetido.
El [ledger final de ocho hallazgos](../dev/tickets/Implementado.md#cierre-final-de-remediación-local--cr-013-a-cr-019-y-cr-030-2026-10-20)
registra revisiones independientes y límites: CR-017 mitigado sin causa histórica
demostrada; CR-013 verificado con reloj virtual, no 1800 s de runtime real.
La preparación de imágenes requiere `prepare-images --allow-downloads CHECKPOINT_ID`
con autorización separada; `start` sólo admite cinco IDs locales verificados y
`up --no-build --pull never`, sin preparación ni fallback de red automáticos.

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

### Managed local database (this workstation)

The managed local PostgreSQL database is the verified development target for this
workstation. From the `invoiceops-app` root, check its state with:

```bash
pnpm db:local:status
```

| Item                            | Verified local value                                        |
| ------------------------------- | ----------------------------------------------------------- |
| PostgreSQL target               | Managed local database; inspect `pnpm db:local:status`      |
| Network scope                   | Loopback only; inspect local status for the current binding |
| PostgreSQL version              | `17.11`                                                     |
| Database / role                 | `invoiceops` / `invoiceops`                                 |
| Applied canonical migrations    | 13 of 13                                                    |
| Existing local data and session | Retained; inspect local status for operator-only details    |

The initial transfer and all 13 canonical migrations were verified. The former
source database container and the two specifically identified obsolete named
PostgreSQL volumes are absent; the current database was rechecked afterward.
The retained full backup was restored and checked in an owned scratch database.
The installed private manifest lets this existing local database run
independently of that source. This workstation-specific state does not describe
first-time setup on another machine.

**Cleanup evidence boundary:** the post-cleanup local state of the named source
container and obsolete volumes was verified. The cleanup commands did not retain
an explicit Docker endpoint/context record, so their execution scope and any
effects outside those verified local objects are **NOT_VERIFIED**. This does not
change the verified state of the current database; it limits claims about the
cleanup operation beyond the observed objects.

To re-run the idempotent local readiness check and native profile proof:

```bash
pnpm db:local:migrate
```

This command does not re-import rows or issue a replacement session while the
recorded session remains valid. The database is bound to loopback; managed
container and volume identity are checked before use. Private credentials,
session token contents, and row fingerprints are not documented or committed.
For current operator guidance, start with `pnpm db:local:status`; it reports
locally needed session metadata without requiring token contents in shared docs.

The local helper does not configure `DATABASE_URL` in the shell or replace the
separate Compose workflow below. Full APP-11 closure and live testnet/EVM
execution are not claimed by this local database readiness result.

1. Crea un archivo `.env` local con las variables requeridas. No incluyas este
   archivo en el control de versiones.

   | Variable             | Propósito                                              | Ejemplo local                                                                                   | Requerida                                                                  |
   | -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
   | `POSTGRES_USER`      | Usuario que PostgreSQL crea para el entorno local      | `invoiceops`                                                                                    | No, Compose usa `invoiceops` por defecto                                   |
   | `POSTGRES_PASSWORD`  | Contraseña local del usuario de PostgreSQL             | `replace-with-a-local-password`                                                                 | Sí, usa una contraseña propia y no la publiques                            |
   | `POSTGRES_DB`        | Base de datos inicial de PostgreSQL                    | `invoiceops`                                                                                    | No, Compose usa `invoiceops` por defecto                                   |
   | `POSTGRES_TEST_PORT` | Puerto del host para PostgreSQL de integración         | `5436`                                                                                          | No, Compose usa `5436` por defecto                                         |
   | `BACKEND_PORT`       | Puerto del host para el backend de Compose             | `3000`                                                                                          | No, Compose usa `3000` por defecto                                         |
   | `FRONTEND_PORT`      | Puerto del host para el frontend de Compose            | `5173`                                                                                          | No, Compose usa `5173` por defecto                                         |
   | `DATABASE_URL`       | Cadena de conexión que usa el backend fuera de Compose | `postgresql://invoiceops:replace-with-a-local-password@localhost:5432/invoiceops?schema=public` | Sí para ejecutar el backend localmente; Compose la construye internamente  |
   | `TEST_DATABASE_URL`  | Uso manual ajeno al gate automatizado de integración   | No configurar para `pnpm test:integration`                                                      | No; el gate genera credenciales efímeras y rechaza valores preconfigurados |
   | `MODEL_API_URL`      | URL base del proveedor de inferencia                   | Sin valor por defecto                                                                           | Sólo para inferencia live; debe configurarse junto a `MODEL_API_MODEL_ID`  |
   | `MODEL_API_MODEL_ID` | Identificador del modelo a invocar                     | Sin valor por defecto                                                                           | Sólo para inferencia live; debe configurarse junto a `MODEL_API_URL`       |

   Usa valores de ejemplo solo en tu equipo. La contraseña de ejemplo no es un
   secreto válido ni debe reutilizarse fuera del desarrollo local.

2. Instala las dependencias:

   ```bash
   pnpm install
   ```

3. Genera el cliente Prisma:

   ```bash
   pnpm generate
   ```

4. Arranca PostgreSQL:

   ```bash
   docker compose up -d db
   ```

5. Aplica las migraciones locales de PostgreSQL con `DATABASE_URL` configurada:

   ```bash
   pnpm --filter @invoiceops/backend exec prisma migrate dev
   ```

   Las migraciones son explícitas: el backend, Docker Compose y el arranque no
   ejecutan cambios de esquema automáticamente.

6. Con `DATABASE_URL` ya disponible en el entorno privado del backend, inicia
   backend y frontend en terminales separadas, sin imprimir ni extraer secretos:

   ```bash
    pnpm --filter @invoiceops/backend dev
   pnpm --filter @invoiceops/frontend dev
   ```

También puedes iniciar ambos procesos de desarrollo con `pnpm dev` si
`DATABASE_URL` está disponible en tu entorno.

## Entorno completo con Compose

```bash
docker compose up --build
```

El primer arranque construye las imágenes y crea el volumen local de PostgreSQL.

## URLs y checks

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`
- Liveness: `http://localhost:3000/health/live`
- Readiness de PostgreSQL: `http://localhost:3000/health/ready`

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
eight baseline migrations, seeds a legacy event, then applies migrations nine
through thirteen. It verifies that the legacy event was not backfilled and runs
10 SQL, 34 organization, seven batch, six reservation, four transaction, two
reconciliation, four CLI authorization, and seven contextual evidence-read cases
sequentially (74 PostgreSQL cases across eight suites). The reservation,
exclusive signer slot, and prepared metadata are
append-only without expiry or release. The slot is global to a chain and signer,
including across contracts: after a crash or ambiguous send, later batches using
that account remain blocked until a separately approved reconciliation procedure
exists. The signer must be application-exclusive; external wallets cannot be
detected or fenced by this database. Signed payloads and private keys must stay
in memory and never enter database rows or logs. A broadcast result is NOT a
receipt or confirmation. The operator CLI is an explicit manual caller, but this
slice does not exercise a live RPC, wire an HTTP caller, replace or retry a
transaction, or schedule automatic reconciliation.

TX06 provides an internal, read-only, point-in-time observation routine. An
authorized batch/context and reservation ID select the persisted prepared hash;
the caller does not supply an RPC hash. The routine checks chain and contract
signer, exact EIP-1559 transaction identity, own receipt, canonical block by
number, and the contract's indexed `RootRegistered(rootHash, signer)` event.
`observedSuccess` and `observedRevert` are provisional observations, NOT
finality or permission to release the global signer slot. Pending, provider
uncertainty, mismatches, and reorgs produce separately appended observations;
earlier observations are never rewritten. The CLI below is an explicit local
operator caller; this routine is not wired to HTTP or a scheduler. Do not retry
a send or infer a released nonce from these rows. The SQL migration is additive;
retain the observation table alongside claims, slots, and prepared hashes on
application rollback.

### Conservative operator CLI (APP-11)

The explicit `evidence-anchor` command requires a valid `APP_SESSION_TOKEN` and
the current database authorization for the supplied organization and owner
context. The configured local operator wallet authorizes the signing capability;
platform-administrator status does not bypass resource ACL checks. Do not pass
actor IDs, session tokens, private keys, or RPC URLs as arguments.

For an anchor operation, configure `EVM_RPC_URL`, `EVM_CHAIN_ID`,
`EVIDENCE_CONTRACT_ADDRESS`, and `EVM_SIGNER_PRIVATE_KEY` in the invocation
environment. Remote RPC endpoints must use HTTPS; plain HTTP is accepted only
for literal `127.0.0.1` or `[::1]`. For reconciliation, only the RPC URL, chain
ID, and contract address are read; the signer key is neither required nor read.
Use a batch and reservation already belonging to the authenticated actor and
context:

```bash
pnpm --filter @invoiceops/backend evidence-anchor --help
pnpm --filter @invoiceops/backend evidence-anchor anchor --batch-id BATCH_ID --organization-id ORG_ID --owner-type user --owner-id OWNER_ID
pnpm --filter @invoiceops/backend evidence-anchor reconcile --batch-id BATCH_ID --organization-id ORG_ID --owner-type user --owner-id OWNER_ID --reservation-id RESERVATION_ID
```

The command returns only a bounded JSON result. A broadcast is reported as
`broadcastedUnknown`, not confirmation. Reconciliation emits provisional
observations; `observedSuccess` is not finality and does not release the signer
slot. Exit status is 0 for a completed command, 1 for authentication/data/
provider failure, and 2 for usage/configuration failure. Never include secrets
in shell history, logs, or shared process listings. A database disconnect failure
is reported only as a categorical stderr diagnostic: it does not replace the
operation result or change its exit status, and it is not a reason to retry.

### Opt-in own-local anchor smoke (APP-11)

From the app root, with installed Anvil/Forge, an offline cached Solidity 0.8.24
compiler, Docker on the local Unix socket, and the cached `postgres:17-alpine`
image, run only when explicitly choosing to create disposable local resources:

```bash
env DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @invoiceops/backend exec node scripts/test-anchor-anvil.mjs
```

Do not supply database URLs or Anvil PID/port overrides. The opt-in script owns a
new loopback Anvil process, checks its PID and listener before any RPC, then
uses the existing runner's new isolated PostgreSQL container and all thirteen
migrations. The eight standard DB suites still run first; the additional smoke suite
compiles the adjacent `invoiceops-contracts/src/EvidenceRootAnchor.sol` offline,
funds an in-memory ephemeral signer with synthetic ETH from the new node's
unlocked developer account, deploys that contract, and exercises the internal
batch submission and read-only observation boundaries. Neither default unit
tests nor `test:integration` start Anvil. Cleanup targets only the captured
Anvil PID and labeled container ID. A failed smoke is NOT proof of registration;
do not retry an uncertain write on an existing node or release the signer slot.
This is not an Express/cookie/UI/TLS or public-network test, and even a passing
receipt and `observedSuccess` do not establish finality or authorize slot reuse.
Together, the eight PostgreSQL suites and this one smoke case cover 75 cases.

Run only against the local socket with a cached `postgres:17-alpine` image:
`DOCKER_HOST=unix:///var/run/docker.sock pnpm test:integration`. The runner
rejects preconfigured database URLs, does not pull images, and verifies the
exact owned container is removed, including on failures. Do not drop or clear
the reservation, slot, or prepared tables to roll back application code: preserve
claims, hashes, and history; apply the additive migration before enabling a
future caller. Rolling back code does not resolve retained signer slots.

Después ejecuta los gates restantes:

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm format:check
docker compose config
```

## Rollout de grupos organizacionales

La migración `20260911170000_add_organization_groups` es un cambio aditivo: crea
`Group` y `GroupMembership`, sus índices y sus claves foráneas compuestas. Antes
de desplegar una versión de la aplicación que use grupos, aplica el esquema con
la misma `DATABASE_URL` del entorno objetivo:

```bash
pnpm --filter @invoiceops/backend exec prisma migrate deploy
```

Las versiones anteriores de la aplicación continúan siendo compatibles mientras
la migración ya aplicada conserve las tablas existentes. La versión con grupos
requiere que esa migración esté desplegada antes de atender tráfico; no habilites
las rutas de grupos contra un esquema anterior.

El rollback seguro y no destructivo consiste en revertir la aplicación a la
versión previa, manteniendo las nuevas tablas y sus datos sin usarlos. No
ejecutes `DROP TABLE` como rollback automático: eliminar `Group` o
`GroupMembership` con datos requiere una decisión operativa explícita, respaldo
verificado y un plan de recuperación aprobado.

## Parada

```bash
docker compose down
```

El comando anterior conserva los datos locales. Para borrar explícitamente el
volumen de PostgreSQL, usa `docker compose down -v` solo si ya no necesitas esos
datos.

## Alcance actual

### Autenticación

El backend expone `POST /auth/login`, `POST /auth/change-password` y
`POST /auth/logout`. No existe registro público ni configuración `AUTH_MODE` o
allowlist. El administrador global provisiona identidades y membresías mediante
la administración autenticada; el script `local-demonstration` conserva su
semilla interna de desarrollo sin habilitar registro público.

`login` sólo recibe `rut` y `password`, responde con una cookie `httpOnly`, `SameSite=Lax` y `Secure` en
producción, y nunca devuelve un token en JSON. Las sesiones se almacenan en
PostgreSQL como hashes; los endpoints protegidos validan la sesión y
autorización en el servidor.

`logout` requiere la cookie válida actual, revoca solamente esa sesión por su
hash, responde `204` y borra la cookie con los mismos atributos. No devuelve
tokens ni revoca otras sesiones activas del usuario.

Ambos endpoints públicos de autenticación limitan los intentos por dirección IP
mediante memoria local: admiten cinco intentos por ventana de 15 minutos y
responden `429` con un mensaje seguro al excederla. El límite es por proceso y
no se comparte entre réplicas; para producción distribuida se requiere un
limitador compartido. La aplicación no habilita `trust proxy`, por lo que detrás
de un proxy inverso los clientes pueden compartir la IP del proxy hasta que la
configuración de despliegue establezca una confianza de proxy correcta.

Los intentos de login de RUT inexistente o de cuentas sin `passwordHash` realizan
la misma verificación `scrypt` contra un hash ficticio válido y reciben la misma
respuesta genérica `401` que una contraseña incorrecta.

La migración APP-02 agrega `passwordHash` nullable para conservar los usuarios
de APP-01. Esas cuentas no pueden iniciar sesión hasta que exista un flujo
seguro de establecimiento de contraseña.

La aplicación incluye facturas, integración opcional con Model API y lectura
acotada de recursos MLflow. APP-10/11 conservan sus servicios internos de evidencia
y anclaje explícito; la UI APP-12 de evidencia es exclusivamente de lectura y no
añade una operación de firma o transmisión.

### Perfil

`GET /profile` resuelve el perfil de la sesión cookie actual y devuelve nombre,
RUT, email, username y memberships con organización y rol. `PATCH /profile`
acepta exclusivamente `email` y `username`; nombre, RUT, password, roles y
memberships no son modificables desde este endpoint. La interfaz consulta el
perfil al iniciar, muestra la carga, una sesión expirada o anónima, y permite
actualizar los dos datos editables sin exponer ni persistir tokens.

### Organization groups

`Group` and `GroupMembership` are organization-scoped. A user can belong to
multiple groups in the same organization, while the database prevents duplicate
group-user pairs and enforces that every group member has an
`OrganizationMembership` in that group organization.

Authenticated users can call `GET /groups` to list only their groups and every
group member in deterministic organization, group, and member order. Group
management is scoped under `/organizations/:organizationId/groups`; only a
current `ADMIN` of that organization can create, update, or delete a group, or
add and remove members. The server validates the current session and resource
organization for every request, returning safe authorization responses for
absent sessions, non-members, and students. The ADMIN who creates a group is
added as its first member so the group remains visible and manageable.

Un administrador de plataforma puede administrar grupos de cualquier
organización, incluso sin una membership local. Esta capacidad se aplica en el
servidor y no depende de permisos entregados por el cliente.

El primer administrador de plataforma se establece fuera de HTTP mediante el
CLI local, con una confirmación explícita:

```bash
pnpm --filter @invoiceops/backend platform-administrator bootstrap <userId> --confirm-bootstrap
```

El CLI también admite la transferencia explícita con `transfer <userId>
--confirm-transfer`. No expone una ruta HTTP de bootstrap ni incluye secretos o
valores operacionales en sus argumentos.

Cookie-authenticated mutations use an Origin same-origin check in central
middleware. Requests carrying the session cookie must include an `Origin` that
exactly matches the request origin; cross-origin requests receive `403` before
the mutation handler. Vite and Nginx proxy `/groups` and `/organizations/` on
the same browser origin as the application.

### MLflow ownership contract

For INT-02, this application remains the academic source of truth. A Workspace
uses `Organization.slug`, an MLflow Basic Auth username uses the normalized
`User.rut`, and the RBAC role for a group is `group-<Group.id>`. `Group.id` is
the canonical immutable cross-repository identity; `Group.name` must never be
used as an MLflow identity, role, resource name, or permission key.

`GroupMembership` maps to assigning the group's RBAC role to the MLflow user.
Individual ML ownership uses `User.id` as `owner_id`; group ownership uses
`Group.id`. The complete contract and explicit out-of-scope provisioning are in
`../dev/tickets/INT-02_ownership_academico_mlflow.md`.

### Consulta de recursos MLflow (APP-09)

`GET /mlflow/resources?organizationId=<id>&ownerType=user|group&ownerId=<id>`
requiere la sesión de InvoiceOps. El backend comprueba la membership de la
organización y del grupo (o el propietario individual) antes de consultar al
proveedor. La pantalla de recursos reutiliza el selector de propietario: consulta
al abrir y cambiar de contexto, y cada 15 segundos mientras la pestaña está
visible. Un fallo conserva la última lectura exitosa del mismo contexto con
aviso de datos anteriores; sin lectura previa ofrece reintento.

Configura **en el entorno del backend** las cuatro variables siguientes (todas
juntas); en Compose se pasan al contenedor backend. No son variables `VITE_*`:

| Variable               | Uso                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MLFLOW_READ_URL`      | Origen REST de MLflow, sin ruta ni credenciales (por ejemplo, `http://127.0.0.1:5000` fuera de Compose; en Compose, sólo una dirección alcanzable desde el contenedor). |
| `MLFLOW_UI_URL`        | Origen al que puede navegar el navegador, independiente del origen REST; no debe apuntar a un hostname interno de Compose.                                              |
| `MLFLOW_READ_USERNAME` | Cuenta de servicio dedicada a lectura, no cuenta administradora.                                                                                                        |
| `MLFLOW_READ_PASSWORD` | Contraseña de esa cuenta; nunca se entrega al navegador.                                                                                                                |

La cuenta y los permisos mínimos admitidos por MLflow 3.16 se crean
**manualmente por el operador**: `USE` sobre cada Workspace objetivo y `READ`
sobre los Experiments y Registered Models concretos. MLflow no admite `READ`
como permiso de Workspace. `USE` también permite crear recursos nuevos en ese
Workspace; por tanto, la cuenta no es estrictamente de solo lectura para todas
las operaciones. No concedas `EDIT` ni `MANAGE` para habilitar esta consulta.
MLFLOW-07 conserva la responsabilidad de aprovisionamiento y reconciliación.
El cliente usa Basic Auth y el header
`X-MLFLOW-WORKSPACE` únicamente desde el backend. Un origen HTTP se acepta sólo
para loopback local; otros destinos requieren HTTPS. Orígenes con path, query,
fragmento o usuario embebido se rechazan al arrancar. En Compose, `localhost`
del backend es su propio contenedor, no el servicio MLflow: para una instancia
en otro contenedor o host, el operador debe proporcionar un origen HTTPS
alcanzable; no se habilita HTTP a otros hosts por conveniencia. Configuración
ausente o parcial deja sólo esta feature en `503 NOT_CONFIGURED`; el resto de
la aplicación permanece disponible. El backend no aprovisiona usuarios ni
concede permisos.

La lectura devuelve a lo sumo 25 runs y 25 versiones por actualización; si hay
continuación, `truncated: true` señala que la lista no es exhaustiva. Respuestas
MLflow inválidas devuelven `502 INVALID_RESPONSE`; errores HTTP, permisos
insuficientes y timeouts de 3 segundos en total (perfil, comprobaciones en
PostgreSQL y lectura REST) devuelven `503 UNAVAILABLE`. El límite corta la
espera HTTP y evita iniciar consultas adicionales al expirar; no cancela una
consulta PostgreSQL ya enviada, porque Prisma no ofrece esa cancelación en
este flujo. Incluso sin configurar el proveedor, un contexto ajeno responde
`404` antes de informar `503 NOT_CONFIGURED` para un contexto autorizado.
La respuesta no incluye credenciales ni URLs provistas por MLflow. Los enlaces
de Experiments, Runs y Model Registry se construyen desde `MLFLOW_UI_URL` y
las rutas de la UI de MLflow 3.16.1 con `?workspace=` en el fragmento. El
navegador debe poder autenticarse **por separado** en la UI de MLflow: la cookie
de InvoiceOps y la cuenta de lectura del backend no proporcionan SSO ni acceso
del navegador. Los permisos nativos de MLflow siguen vigentes al abrir el enlace.
En la validación histórica local con MLflow 3.16.0, una cuenta técnica con `USE` sólo en
el Workspace académico y `READ` exacto sobre sus recursos pudo leerlos por API,
pero `GET /` de la UI respondió `403` aun al añadir `?workspace=` a la URL base.
Por tanto, probar sólo la URL y el fragmento no acreditaba navegación. El pin
publicado `3.16.1` resolvió ese bloqueo en el stack local: una identidad no
administradora abrió en Chrome, desde el enlace renderizado por InvoiceOps,
la página real de una versión en el Workspace seleccionado. El documento inicial
devolvió `200`, mientras el acceso anónimo conservó `401`, una ruta desconocida
conservó `403` y fail-closed permaneció activo. La identidad tuvo `USE` sólo en
su Workspace y `READ` sobre recursos concretos; no se concedió acceso adicional
al Workspace predeterminado. Esta prueba host-local no demuestra SSO ni TLS o
despliegue Compose productivo: cada navegador aún debe autenticarse en MLflow.
Las rutas se contrastaron inicialmente con el código publicado de MLflow 3.16.0:
[`experiment-tracking/routes.ts`](https://github.com/mlflow/mlflow/blob/v3.16.0/mlflow/server/js/src/experiment-tracking/routes.ts),
[`model-registry/routes.ts`](https://github.com/mlflow/mlflow/blob/v3.16.0/mlflow/server/js/src/model-registry/routes.ts)
y [`WorkspaceUtils.ts`](https://github.com/mlflow/mlflow/blob/v3.16.0/mlflow/server/js/src/workspaces/utils/WorkspaceUtils.ts).

**Despliegue:** configura ambos orígenes para el entorno y una cuenta técnica
con `USE` en los Workspaces necesarios y `READ` sobre los recursos exactos;
confirma una lectura individual y otra grupal, recursos ausentes, permisos
insuficientes, enlaces y sesión de navegador con un operador autorizado. Esta
comprobación contra el proveedor operado no forma parte de las pruebas
unitarias. **Rollback:** retira las
cuatro variables y vuelve a desplegar el backend (la vista muestra un error
recuperable), o revierte la versión de aplicación; no hay migraciones ni datos
que deshacer. La rotación o revocación de la cuenta de lectura es operativa e
independiente de InvoiceOps.

### Policies de negocio versionadas

APP-07 conserva `invoice-rules-v1` sin cambios: procesa automáticamente sólo
facturas de hasta `500000` centavos con PO y three-way match. La decisión se
solicita con `POST /invoices/:invoiceId/decision` usando `{ "mode": "RULE_V1" }`;
el servidor calcula y persiste el resultado, por lo que el navegador no envía
`AUTO_PROCESS` ni `MANUAL_REVIEW` como una decisión autoritativa.

El modo `PROBABILITY_POLICY` requiere una versión explícita:

```json
{
  "mode": "PROBABILITY_POLICY",
  "policyVersion": "ml-policy-v1"
}
```

Las policies son owner-scoped por organización y contienen `version` y
`manualReviewThreshold` entre 0 y 1. Las individuales sólo las administra su
propietario; las grupales sólo un `ADMIN` de la organización. Se consultan,
crean y actualizan mediante `GET`, `POST` y `PATCH /business-policies` en el
mismo contexto `organizationId`, `ownerType` y `ownerId` de las facturas.

`PROBABILITY_POLICY` invoca el Model API sólo cuando `MODEL_API_URL` y
`MODEL_API_MODEL_ID` están configuradas. No existe una URL ni un modelo por
defecto. Si falta cualquiera de las dos variables, el proveedor se considera no
disponible; también se trata así un timeout, error HTTP o respuesta inválida. En
esos casos el cliente recibe la respuesta normal de la decisión y el servidor
persiste únicamente el fallback seguro `MANUAL_REVIEW`, con
`policyProbabilitySource: "MODEL_API_FALLBACK"` y metadata de modelo nula. No se
exponen detalles del proveedor en la respuesta HTTP.

`RULE_V1` permanece disponible e independiente de esta configuración. Con
inferencia disponible, `probability >= threshold` resulta en `MANUAL_REVIEW`.
Cada evento de auditoría conserva modo, versión, threshold, probabilidad, fuente,
recomendación y, cuando existe inferencia, modelo lógico, versión y run.

### Contrato App ↔ Model API (INT-01, v1)

La fuente de verdad del request y response HTTP es `PredictRequest` y
`PredictResponse` en Model API; el adaptador de la aplicación está en
`apps/backend/src/model-api-client.ts`. No existe un repositorio de contratos
independiente. La versión `v1` describe el contrato documentado; **no** añade
un segmento a la URL ni un campo al JSON. El ID lógico estable del catálogo
actual es `invoice-review`; configura ese valor en `MODEL_API_MODEL_ID` junto
con `MODEL_API_URL`. La aplicación codifica el ID como un único segmento de URL.

`POST /models/{model_id}/predict` recibe únicamente estas ocho features:

```json
{
  "invoice_amount_cents": 125000,
  "vendor_tenure_days": 365,
  "previous_incidents_12m": 1,
  "amount_vs_vendor_median": 1.25,
  "has_purchase_order": true,
  "three_way_match": true,
  "bank_account_recently_changed": false,
  "country_risk": "low"
}
```

Los tres primeros campos son enteros JSON; `amount_vs_vendor_median` es
numérico; los tres siguientes son booleanos JSON y `country_risk` es string.
Model API exige presencia, tipos estrictos y ausencia de campos adicionales;
rechaza con `422` el body inválido. `low`, `medium` y `high` son las categorías
entrenadas que envía la aplicación; el schema público actual del proveedor
admite cualquier string en `country_risk` y no restringe el dominio a esas tres.
No se transmiten identificadores de factura, credenciales ni datos de MLflow.

Respuesta exitosa de ejemplo:

```json
{
  "model_id": "invoice-review",
  "model_version": "7",
  "run_id": "run-123",
  "probability": 0.8
}
```

`model_id` identifica el modelo lógico solicitado; `model_version` y `run_id`
son identificadores string no vacíos de la instancia servida, no parámetros
MLflow del consumidor. `probability` es un número finito entre 0 y 1 (inclusive)
de la clase positiva `1`, correspondiente a revisión manual; no es una decisión.
La aplicación valida estos cuatro campos y exige que `model_id` coincida
exactamente con el ID configurado. Un ID ajeno, JSON inválido, respuesta HTTP no
exitosa, timeout de 2 segundos o probabilidad inválida disparan el fallback
auditable `MANUAL_REVIEW` / `MODEL_API_FALLBACK`, con probabilidad y metadata de
modelo nulas. La aplicación conserva el cálculo de threshold y recomendación.

El proveedor responde `404` para ID desconocido, `422` para request inválido y
`503` para modelo conocido no disponible o inferencia inválida/fallida; el
cliente no expone el detalle de esos errores. Para compatibilidad v1, conservar
los ocho campos de entrada, los cuatro campos de salida, sus tipos y la semántica
de probabilidad e ID; añadir campos de salida es tolerado por el cliente actual,
pero cambiar o eliminar campos existentes requiere un contrato versionado nuevo
y coordinación de ambos repositorios. No se exige una versión de modelo fija:
el champion puede cambiar manteniendo el mismo contrato HTTP.

La migración APP-08 es aditiva: agrega los campos de auditoría nullable y permite
la fuente `MODEL_API_FALLBACK`. Para revertir una aplicación, se revierte el
código y se conservan las columnas y eventos existentes; no se ejecuta un `DROP`
automático.

Para una demostración local repetible, con `DATABASE_URL` apuntando a la base
local `invoiceops` en `localhost` o al servicio Compose `db`, ejecuta:

```bash
NODE_ENV=development pnpm --filter @invoiceops/backend local-demonstration
```

El comando exige `NODE_ENV=development` y rechaza destinos remotos,
`invoiceops_test` y cualquier base distinta de `invoiceops`. Sólo crea o restablece los registros dedicados
`LOCAL_DEMONSTRATION`: la organización `APP-07 Local Demonstration`, el usuario
de prueba RUT `111111111` con contraseña `app-07-local-demonstration`, la policy
`ml-policy-v1` (threshold `0.8`) y dos facturas `PENDING`. En la UI, selecciona
esa organización y propietario individual. `DEMO-RULE-AUTO-POLICY-MANUAL`
resulta `AUTO_PROCESS` con Rule v1 y `MANUAL_REVIEW` con la policy; la segunda,
`DEMO-RULE-MANUAL-POLICY-AUTO`, invierte esos resultados. Ejecuta nuevamente el
comando entre intentos para restablecer sólo esas facturas demo a `PENDING`.

Antes de desplegar APP-07, aplica la migración explícita y luego la aplicación:

```bash
pnpm --filter @invoiceops/backend exec prisma migrate deploy
```

La migración es expansiva y no incluye backfill. Para rollback operativo,
revierte la aplicación a la versión previa y conserva las columnas y la tabla
`BusinessPolicy`; no elimines datos o esquema automáticamente.
