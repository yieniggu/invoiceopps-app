#!/bin/sh
# Creates the unprivileged role the application connects as. The official
# postgres image runs this only while initialising an EMPTY data directory;
# changing the variables later has no effect on an existing volume.
#
# Runs as the owner (POSTGRES_USER), which is also who applies the migrations,
# so default privileges for objects the owner creates later reach the app role.
# The password is read inside psql from the environment: it never appears in
# argv, in this script's output or in the SQL log.
set -eu

app_user="${POSTGRES_APP_USER:-invoiceops_app}"
if [ -z "${POSTGRES_APP_PASSWORD:-}" ]; then
  echo "POSTGRES_APP_PASSWORD is required" >&2
  return 1 2>/dev/null || exit 1
fi
if [ "$app_user" = "$POSTGRES_USER" ]; then
  echo "POSTGRES_APP_USER must differ from POSTGRES_USER (the owner)" >&2
  return 1 2>/dev/null || exit 1
fi

psql -v ON_ERROR_STOP=1 --no-psqlrc \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_role="$app_user" -v owner_role="$POSTGRES_USER" -v db_name="$POSTGRES_DB" <<'SQL'
\set app_password `printenv POSTGRES_APP_PASSWORD`
CREATE ROLE :"app_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";
GRANT USAGE ON SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"app_role";
SQL
