-- MLflow API token scopes (MLOPS-01). Additive and idempotent: existing
-- invoices:* values, tokens and constraints are untouched. Rolling the
-- application back is safe; PostgreSQL cannot remove an enum value, so the two
-- values simply stay unused by the older release.

-- AlterEnum
ALTER TYPE "ApiTokenScope" ADD VALUE IF NOT EXISTS 'mlflow:read';
ALTER TYPE "ApiTokenScope" ADD VALUE IF NOT EXISTS 'mlflow:write';
