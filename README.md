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

5. En terminales separadas, inicia backend y frontend:

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

Este scaffold no incluye autenticación, organizaciones, usuarios, facturas,
integraciones MLflow, Model API ni blockchain. Estas capacidades pertenecen a
los tickets posteriores.
