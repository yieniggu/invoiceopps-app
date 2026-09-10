# InvoiceOps App

Scaffold inicial de la aplicación InvoiceOps. Incluye un backend Express con
TypeScript, un frontend React con Vite y PostgreSQL para desarrollo local.

## Requisitos

- Node.js 24 o superior.
- pnpm 11 o superior.
- Docker Desktop con Docker Compose, para ejecutar el entorno completo.

## Configuración local

1. Crea un archivo `.env` local con las variables requeridas. No incluyas este
   archivo en el control de versiones.

   | Variable            | Propósito                                              | Ejemplo local                                                                                   | Requerida                                                                 |
   | ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
   | `POSTGRES_USER`     | Usuario que PostgreSQL crea para el entorno local      | `invoiceops`                                                                                    | No, Compose usa `invoiceops` por defecto                                  |
   | `POSTGRES_PASSWORD` | Contraseña local del usuario de PostgreSQL             | `replace-with-a-local-password`                                                                 | Sí, usa una contraseña propia y no la publiques                           |
   | `POSTGRES_DB`       | Base de datos inicial de PostgreSQL                    | `invoiceops`                                                                                    | No, Compose usa `invoiceops` por defecto                                  |
   | `BACKEND_PORT`      | Puerto del host para el backend de Compose             | `3000`                                                                                          | No, Compose usa `3000` por defecto                                        |
   | `FRONTEND_PORT`     | Puerto del host para el frontend de Compose            | `5173`                                                                                          | No, Compose usa `5173` por defecto                                        |
   | `DATABASE_URL`      | Cadena de conexión que usa el backend fuera de Compose | `postgresql://invoiceops:replace-with-a-local-password@localhost:5432/invoiceops?schema=public` | Sí para ejecutar el backend localmente; Compose la construye internamente |

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

6. En terminales separadas, inicia backend y frontend:

   ```bash
   DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d '=' -f2-)" pnpm --filter @invoiceops/backend dev
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

Las pruebas de integración usan una base efímera llamada exactamente
`invoiceops_test`. Crea una instancia aislada, aplica las migraciones y ejecuta
el gate explícito:

```bash
docker run --rm --name invoiceops-test-db \
  -e POSTGRES_USER=invoiceops \
  -e POSTGRES_PASSWORD=invoiceops-test-password \
  -e POSTGRES_DB=invoiceops_test \
  -p 5433:5432 postgres:18

export TEST_DATABASE_URL='postgresql://invoiceops:invoiceops-test-password@localhost:5433/invoiceops_test?schema=public'
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @invoiceops/backend exec prisma migrate deploy
pnpm test:integration
```

`pnpm test:integration` falla controladamente si `TEST_DATABASE_URL` no está
definida o no apunta a `invoiceops_test`, antes de ejecutar cualquier
`deleteMany`. Estas pruebas limpian tablas y nunca deben usar la base local de
Compose, una base compartida ni una base con datos que deban conservarse.

Cuando finalice, detén la instancia efímera con `Ctrl-C`; `--rm` elimina el
contenedor. Después ejecuta los gates restantes:

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm format:check
docker compose config
```

## Parada

```bash
docker compose down
```

El comando anterior conserva los datos locales. Para borrar explícitamente el
volumen de PostgreSQL, usa `docker compose down -v` solo si ya no necesitas esos
datos.

## Alcance actual

### Autenticación

El backend expone `POST /auth/signup` y `POST /auth/login`. El modo se define
con `AUTH_MODE=open` (valor por defecto) o `AUTH_MODE=allowlist`. En el modo
restringido, un operador debe registrar el RUT normalizado y la organización en
`AuthorizedUserOrganization` antes del registro; un RUT puede estar autorizado
para varias organizaciones y recibirá una membership `STUDENT` en cada una.

`signup` recibe `name`, `rut` y `password`. `login` sólo recibe `rut` y
`password`, responde con una cookie `httpOnly`, `SameSite=Lax` y `Secure` en
producción, y nunca devuelve un token en JSON. Las sesiones se almacenan en
PostgreSQL como hashes; los endpoints protegidos de tickets posteriores deben
validar la sesión y autorización en el servidor.

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

Este scaffold no incluye facturas, integraciones MLflow, Model API ni
blockchain. Estas capacidades pertenecen a los tickets posteriores.
