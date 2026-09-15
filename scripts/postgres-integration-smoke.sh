#!/bin/sh
set -eu

project_token_file="$(mktemp "${TMPDIR:-/tmp}/invoiceops-app-int02-smoke.XXXXXX")"
project_name="invoiceops-app-int02-smoke-${project_token_file##*.}"
project_name="$(printf '%s' "$project_name" | tr '[:upper:]' '[:lower:]')"
compose_file="docker-compose.yml"
smoke_compose_file="docker-compose.smoke.yml"
postgres_user="invoiceops"
postgres_password="replace-with-a-local-password"

compose() {
  POSTGRES_USER="$postgres_user" \
    POSTGRES_PASSWORD="$postgres_password" \
    POSTGRES_TEST_PORT=0 \
    docker compose --env-file /dev/null -p "$project_name" \
      -f "$compose_file" -f "$smoke_compose_file" --profile test "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$project_token_file"
}

trap cleanup EXIT HUP INT TERM

# This validates the guard before a disposable database is started.
if env -u TEST_DATABASE_URL pnpm test:integration >/tmp/invoiceops-postgres-smoke-negative.log 2>&1; then
  printf '%s\n' 'Expected TEST_DATABASE_URL guard to reject a missing value.' >&2
  exit 1
fi

if ! grep -Fq 'TEST_DATABASE_URL must be configured for database integration tests' \
  /tmp/invoiceops-postgres-smoke-negative.log; then
  printf '%s\n' 'The missing TEST_DATABASE_URL guard did not report its expected error.' >&2
  exit 1
fi

compose config --quiet
compose up -d --wait --wait-timeout 90 db-test

host_port="$(compose port db-test 5432)"
test_database_url="postgresql://${postgres_user}:${postgres_password}@${host_port}/invoiceops_test?schema=public"

DATABASE_URL="$test_database_url" \
  pnpm --filter @invoiceops/backend exec prisma migrate deploy
TEST_DATABASE_URL="$test_database_url" pnpm test:integration

printf '%s\n' 'PostgreSQL integration smoke passed with disposable Compose resources.'
