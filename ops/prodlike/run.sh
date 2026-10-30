#!/usr/bin/env bash
# Prod-like local test of compose.production.yml (no real server, no Cloudflare).
#
#   bash ops/prodlike/run.sh          # build, start, run every check, KEEP the stack
#   bash ops/prodlike/run.sh --down   # remove everything this script created
#
# Simulates the real edge with an nginx doing TLS (`edge-sim`) and a hostile
# container on the shared edge network (`hostile-peer`). Everything uses the
# docker project `invoiceops-prodlike`, the network `invoiceops-prodlike-edge`
# and throwaway secrets; nothing else on the docker daemon is touched.
# Requires on the host: docker compose, openssl, curl, node, python3, expect.
# (ops/smoke.sh itself needs only curl + python3; section 8 proves it in an
# Ubuntu container without Node.)
# Env: PRODLIKE_HTTPS_PORT (8443), PRODLIKE_PLATFORM (linux/amd64).
set -euo pipefail

cd "$(dirname "$0")/../.."

PROJECT=invoiceops-prodlike
export INVOICEOPS_EDGE_NETWORK=invoiceops-prodlike-edge
export INVOICEOPS_VERSION=prodlike
export PRODLIKE_HTTPS_PORT="${PRODLIKE_HTTPS_PORT:-8443}"
PRODLIKE_DIR="${TMPDIR:-/var/tmp}"
export PRODLIKE_DIR="${PRODLIKE_DIR%/}/invoiceops-prodlike"
ORIGIN="https://localhost:$PRODLIKE_HTTPS_PORT"
ENV_FILE="$PRODLIKE_DIR/prodlike.env"
CERT="$PRODLIKE_DIR/tls/cert.pem"

dc() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    -f compose.production.yml -f ops/prodlike/compose.prodlike.yml "$@"
}

teardown() {
  if [[ -f "$ENV_FILE" ]]; then
    dc --profile ops down -v --remove-orphans || true
  else
    PRODLIKE_DIR=/nonexistent POSTGRES_PASSWORD=unused docker compose -p "$PROJECT" --env-file /dev/null \
      -f compose.production.yml -f ops/prodlike/compose.prodlike.yml \
      --profile ops down -v --remove-orphans || true
  fi
  docker network rm "$INVOICEOPS_EDGE_NETWORK" >/dev/null 2>&1 || true
  docker image rm "invoiceops-backend:$INVOICEOPS_VERSION" "invoiceops-web:$INVOICEOPS_VERSION" \
    "invoiceops-backend-tooling:$INVOICEOPS_VERSION" >/dev/null 2>&1 || true
  docker rm -f invoiceops-prodlike-ipfill >/dev/null 2>&1 || true
  rm -rf "$PRODLIKE_DIR"
}

if [[ "${1:-}" == "--down" ]]; then
  teardown
  echo "prodlike stack removed"
  exit 0
fi

# ---------------------------------------------------------------- helpers ---
failures=0
STATUS="" BODY="" HEADERS="" SIM_IP="203.0.113.1"
section() { printf '\n== %s\n' "$1"; }
# check "name" '<bash expression>' - evaluated now, against the last response.
check() {
  if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}
# http METHOD PATH [curl args...] -> STATUS BODY HEADERS (lower-case), as client $SIM_IP.
http() {
  local method="$1" path="$2"
  shift 2
  STATUS="$(curl -sS --max-time 30 --cacert "$CERT" -X "$method" \
    -o "$PRODLIKE_DIR/body" -D "$PRODLIKE_DIR/headers" -w '%{http_code}' \
    -H "X-Sim-Client-IP: $SIM_IP" "$@" "$ORIGIN$path" || echo 000)"
  BODY="$(tr -d '\r' < "$PRODLIKE_DIR/body")"
  HEADERS="$(tr -d '\r' < "$PRODLIKE_DIR/headers" | tr '[:upper:]' '[:lower:]')"
}
# Hardening headers (HEADERS is lower-case) and no `Server: nginx/<version>`.
security_headers_ok() {
  [[ $HEADERS == *"x-content-type-options: nosniff"* && $HEADERS == *"x-frame-options: deny"* &&
    $HEADERS == *"referrer-policy: same-origin"* &&
    $HEADERS == *"strict-transport-security: max-age=31536000"* &&
    $HEADERS != *"includesubdomains"* ]]
}
server_version_hidden() { [[ $HEADERS != *"server: nginx/"* ]]; }
# owner_sql RUT < sql : runs SQL as the database owner, psql variable :rut set.
owner_sql() {
  dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v rut="$0" -f -' "$1"
}
# web_health : health status of the current web container.
web_health() { docker inspect --format '{{.State.Health.Status}}' "$(dc ps -q web)" 2>/dev/null || echo none; }
json() { node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))' "$1"; }
login_payload() { # rut password
  node -e 'process.stdout.write(JSON.stringify({ rut: process.argv[1], password: process.argv[2] }))' "$1" "$2"
}
# peer METHOD URL COUNT ORIGIN_HEADER(or -) HEADER=VALUE... : requests from the hostile container
# (a raw node http client so Host/Origin/Cookie can be forged); prints the status of each request.
peer() {
  dc exec -T hostile-peer node -e '
    const http = require("node:http");
    const [method, url, count, origin, ...pairs] = process.argv.slice(1);
    const headers = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
    if (origin !== "-") headers.Origin = origin;
    // A fresh RUT per request keeps the per-RUT limiter out of the picture: only the IP key can lock.
    const bodyFor = () => (method === "POST" ? JSON.stringify({ rut: String(Math.floor(1e7 + Math.random() * 9e7)) + "-9", password: "wrong-password" }) : undefined);
    if (method === "POST") headers["Content-Type"] = "application/json";
    const one = (i) => new Promise((resolve) => {
      const h = { ...headers };
      for (const k of Object.keys(h)) h[k] = h[k].replaceAll("{i}", String(i));
      const req = http.request(url, { method, headers: h }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(res.statusCode + (res.statusCode >= 400 && /"code":"([A-Z_]+)"/.test(data) ? ":" + data.match(/"code":"([A-Z_]+)"/)[1] : "")));
      });
      req.on("error", (e) => resolve("ERR:" + e.code));
      req.end(bodyFor());
    });
    (async () => { const out = []; for (let i = 1; i <= Number(count); i++) out.push(await one(i)); console.log(out.join(" ")); })();
  ' -- "$@"
}

# -------------------------------------------------------------- bootstrap ---
section "Setup (throwaway secrets, certificate, edge network)"
teardown
mkdir -p "$PRODLIKE_DIR/tls"
chmod 700 "$PRODLIKE_DIR"

PG_PASSWORD="$(openssl rand -hex 24)"
APP_USER=invoiceops_app
APP_PASSWORD="$(openssl rand -hex 24)"
ADMIN_TEMP_PASSWORD="$(openssl rand -hex 12)"
ADMIN_NEW_PASSWORD="$(openssl rand -hex 12)"
ADMIN_RUT="12.345.678-5"
export PRODLIKE_ADMIN_NAME="Prodlike Admin" PRODLIKE_ADMIN_RUT="$ADMIN_RUT" \
  PRODLIKE_ADMIN_TEMP_PASSWORD="$ADMIN_TEMP_PASSWORD"

(umask 077 && cat > "$ENV_FILE" <<EOF
POSTGRES_USER=invoiceops
POSTGRES_DB=invoiceops
POSTGRES_PASSWORD=$PG_PASSWORD
POSTGRES_APP_USER=$APP_USER
POSTGRES_APP_PASSWORD=$APP_PASSWORD
PUBLIC_ORIGIN=$ORIGIN
INVOICEOPS_VERSION=$INVOICEOPS_VERSION
EOF
)

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$PRODLIKE_DIR/tls/key.pem" -out "$CERT" 2>/dev/null
chmod 644 "$PRODLIKE_DIR/tls/key.pem"

# Cloudflare simulation: the real client address is whatever the test says in
# X-Sim-Client-IP (else the socket address) and is written to CF-Connecting-IP,
# overwriting anything the caller sent. X-Forwarded-For is appended like a real
# tunnel does, so forged chains reach the origin and must be ignored by it.
cat > "$PRODLIKE_DIR/edge.conf" <<'EOF'
server_tokens off;
map $http_x_sim_client_ip $sim_client_ip {
  default $remote_addr;
  "~." $http_x_sim_client_ip;
}
server {
  listen 443 ssl;
  ssl_certificate /etc/nginx/tls/cert.pem;
  ssl_certificate_key /etc/nginx/tls/key.pem;
  location / {
    proxy_pass http://invoiceops-web:80;
    proxy_set_header Host $host;
    proxy_set_header CF-Connecting-IP $sim_client_ip;
    proxy_set_header X-Sim-Client-IP "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
EOF

docker network create "$INVOICEOPS_EDGE_NETWORK" >/dev/null

section "Build images (${PRODLIKE_PLATFORM:-linux/amd64})"
dc --profile ops build

section "Database, migrations (twice: idempotent), bootstrap"
dc up -d --wait db
first_migrate="$(dc run --rm -T migrate 2>&1)" || true
echo "$first_migrate"
check "first migrate applied the migrations" '[[ $first_migrate == *"All migrations have been successfully applied"* ]]'
second_migrate="$(dc run --rm -T migrate 2>&1)" || true
echo "$second_migrate"
check "second migrate found nothing to apply" '[[ $second_migrate == *"No pending migrations to apply"* ]]'
expect -f ops/prodlike/bootstrap.exp -- docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
  -f compose.production.yml -f ops/prodlike/compose.prodlike.yml run --rm bootstrap
echo "bootstrap finished"

section "Start the stack"
dc up -d --wait

# ----------------------------------------------------------------- checks ---
section "1. Static app and SPA"
http GET /
INDEX="$BODY"
check "GET / is the built app (200, module script tag)" '[[ $STATUS == 200 && $BODY == *"<script type=\"module\""* ]]'
check "GET / carries the security headers (CR-406)" security_headers_ok
check "GET / hides the nginx version (Server: nginx)" server_version_hidden
check "GET / is Cache-Control: no-cache" '[[ $HEADERS == *"cache-control: no-cache"* ]]'
ASSET=""
for token in ${INDEX//\"/ }; do
  if [[ "$token" == /assets/*.js ]]; then ASSET="$token"; break; fi
done
http GET "${ASSET:-/assets/missing.js}"
check "asset $ASSET is 200 JavaScript" '[[ $STATUS == 200 && $HEADERS == *"content-type:"*javascript* ]]'
check "asset carries the security headers (CR-406)" security_headers_ok
check "asset is cached as immutable for a year" '[[ $HEADERS == *"cache-control: public, max-age=31536000, immutable"* ]]'
gzip_headers="$(curl -sS --cacert "$CERT" -H 'Accept-Encoding: gzip' -H "X-Sim-Client-IP: $SIM_IP" -D - -o /dev/null "$ORIGIN${ASSET:-/assets/missing.js}" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
check "asset is gzip-compressed when asked" '[[ $gzip_headers == *"content-encoding: gzip"* ]]'
http GET /assets/does-not-exist.js
check "missing asset is 404, not the SPA index" '[[ $STATUS == 404 && $BODY != "$INDEX" ]]'
check "404 also carries the security headers (always)" security_headers_ok
http GET /admin/users
check "deep SPA route /admin/users serves index.html" '[[ $STATUS == 200 && $BODY == "$INDEX" ]]'
http GET /healthz
check "GET /healthz is ok" '[[ $STATUS == 200 && $BODY == ok ]]'

direct="$(dc exec -T hostile-peer wget -S -qO /dev/null http://invoiceops-web/ 2>&1 | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
check "web answers directly (no edge) with Server: nginx and no version" '[[ $direct == *"server: nginx"* && $direct != *"nginx/"* ]]'
check "web answers directly with the four security headers" \
  '[[ $direct == *"x-content-type-options: nosniff"* && $direct == *"x-frame-options: deny"* && $direct == *"referrer-policy: same-origin"* && $direct == *"strict-transport-security: max-age=31536000"* ]]'

section "2. API surface"
http GET /api/v1/auth/profile
check "profile without cookie is 401 JSON" '[[ $STATUS == 401 && $BODY == *UNAUTHENTICATED* ]]'
check "API response carries the security headers (CR-406)" security_headers_ok
check "API response hides the nginx version" server_version_hidden
http GET /openapi.json
check "GET /openapi.json is 200" '[[ $STATUS == 200 && $BODY == *\"openapi\"* ]]'

section "2b. Expired temporary password and the documented recovery (CR-411)"
# DEPLOY.md documents this exact statement for an administrator who did not
# log in within 24 h (no application-level recovery exists for the only admin).
ADMIN_RUT_DB="${ADMIN_RUT//[.-]/}"
expired="$(owner_sql "$ADMIN_RUT_DB" <<'SQL'
UPDATE "User" SET "temporaryPasswordExpiresAt" = now() - interval '1 hour'
WHERE rut = :'rut' AND "mustChangePassword" = true;
SQL
)"
check "simulated expiry touched exactly one user ($expired)" '[[ $expired == "UPDATE 1" ]]'
http POST /api/v1/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  --data "$(login_payload "$ADMIN_RUT" "$ADMIN_TEMP_PASSWORD")"
check "login with the expired temporary password is 401" '[[ $STATUS == 401 ]]'
recovered="$(owner_sql "$ADMIN_RUT_DB" <<'SQL'
UPDATE "User" SET "temporaryPasswordExpiresAt" = now() + interval '24 hours'
WHERE rut = :'rut' AND "mustChangePassword" = true;
SQL
)"
check "documented recovery updated exactly one user ($recovered)" '[[ $recovered == "UPDATE 1" ]]'

section "3. Login over HTTPS, mandatory password change"
JAR="$PRODLIKE_DIR/jar"
http POST /api/v1/auth/login -c "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  --data "$(login_payload "$ADMIN_RUT" "$ADMIN_TEMP_PASSWORD")"
check "login with the temporary password is 200" '[[ $STATUS == 200 ]]'
check "cookie is Secure, HttpOnly, SameSite=Lax" \
  '[[ $HEADERS == *"set-cookie:"*"; secure"* && $HEADERS == *"; httponly"* && $HEADERS == *"samesite=lax"* ]]'
http GET /api/v1/auth/profile -b "$JAR"
check "profile reports mustChangePassword=true" '[[ $STATUS == 200 && $BODY == *\"mustChangePassword\":true* ]]'
http GET /api/v1/organizations -b "$JAR"
check "other routes are blocked until the password changes (403)" '[[ $STATUS == 403 ]]'
http POST /api/v1/auth/change-password -b "$JAR" -c "$JAR" -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({ currentPassword: process.argv[1], newPassword: process.argv[2] }))' "$ADMIN_TEMP_PASSWORD" "$ADMIN_NEW_PASSWORD")"
check "change-password with the public Origin is 204 (D01 fixed behind TLS proxy)" '[[ $STATUS == 204 ]]'
http GET /api/v1/auth/profile -b "$JAR"
check "session read after the change is 200, mustChangePassword=false" \
  '[[ $STATUS == 200 && $BODY == *\"mustChangePassword\":false* ]]'

section "4. Write that persists, forged origins rejected"
ORG='{"name":"Prodlike Org","slug":"prodlike-org","firstAdminRut":"12.345.678-5"}'
http POST /api/v1/organizations -b "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' --data "$ORG"
check "create organization with the correct Origin is 201" '[[ $STATUS == 201 ]]'
http POST /api/v1/organizations -b "$JAR" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
  --data '{"name":"Evil","slug":"evil-org","firstAdminRut":"12.345.678-5"}'
check "same write with Origin https://evil.example is 403 FORBIDDEN_ORIGIN" '[[ $STATUS == 403 && $BODY == *FORBIDDEN_ORIGIN* ]]'
http POST /api/v1/organizations -b "$JAR" -H 'Origin: https://evil.example' -H 'X-Forwarded-Proto: https' \
  -H 'X-Forwarded-Host: evil.example' -H 'Content-Type: application/json' \
  --data '{"name":"Evil","slug":"evil-org","firstAdminRut":"12.345.678-5"}'
check "spoofed X-Forwarded-Proto/Host cannot make a wrong Origin pass" '[[ $STATUS == 403 && $BODY == *FORBIDDEN_ORIGIN* ]]'
http POST /api/v1/organizations -b "$JAR" -H 'Content-Type: application/json' \
  --data '{"name":"Evil","slug":"evil-org","firstAdminRut":"12.345.678-5"}'
check "write without Origin is 403 FORBIDDEN_ORIGIN" '[[ $STATUS == 403 && $BODY == *FORBIDDEN_ORIGIN* ]]'
http GET "/api/v1/organizations" -b "$JAR"
check "only the legitimate organization exists" '[[ $BODY == *prodlike-org* && $BODY != *evil-org* ]]'

section "5. Rate limiting is per real client"
SIM_IP=203.0.113.10
limited_at=0
for i in 1 2 3 4 5 6 7 8; do
  http POST /api/v1/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
    --data "$(login_payload "9${i}.000.000-0" wrong-password)"
  if [[ $STATUS == 429 ]]; then limited_at=$i; break; fi
done
check "client 203.0.113.10 gets 429 after repeated failed logins (at attempt $limited_at)" '((limited_at >= 2 && limited_at <= 7))'
SIM_IP=203.0.113.20
http POST /api/v1/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  --data "$(login_payload "98.000.000-0" wrong-password)"
check "a different client 203.0.113.20 is NOT limited (401)" '[[ $STATUS == 401 ]]'
SIM_IP=203.0.113.10
http POST /api/v1/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 198.51.100.1' --data "$(login_payload "97.000.000-0" wrong-password)"
check "a forged X-Forwarded-For does not change the identity (still 429)" '[[ $STATUS == 429 ]]'

section "6. Hostile peer on the shared edge network"
check "control: peer reaches invoiceops-web:80" 'dc exec -T hostile-peer nc -z -w 3 invoiceops-web 80'
check "peer cannot reach invoiceops-backend:3000" '! dc exec -T hostile-peer nc -z -w 3 invoiceops-backend 3000'
check "peer cannot reach db:5432" '! dc exec -T hostile-peer nc -z -w 3 db 5432'
check "peer cannot resolve the generic name backend" '! dc exec -T hostile-peer nslookup backend'
R="$(peer POST http://invoiceops-web/api/v1/auth/login 8 - CF-Connecting-IP=203.0.113.77)"
echo "      forged CF-Connecting-IP=203.0.113.77, 8 failed logins: $R"
check "RESIDUAL RISK: a peer inside the private edge range IS trusted for CF-Connecting-IP (limited as 203.0.113.77)" '[[ $R == *429* ]]'
R="$(peer POST http://invoiceops-web/api/v1/auth/login 1 - CF-Connecting-IP=203.0.113.78)"
check "RESIDUAL RISK: the same peer picks another identity at will (203.0.113.78 not limited: $R)" '[[ $R == 401* ]]'
R="$(peer POST http://invoiceops-web/api/v1/auth/login 8 - 'X-Forwarded-For=198.51.100.{i}')"
echo "      8 failed logins with a different forged X-Forwarded-For each: $R"
check "forged X-Forwarded-For alone cannot dodge the limiter (peer address is the identity)" '[[ $R == *429* ]]'
R="$(peer POST http://invoiceops-web/api/v1/auth/logout 1 https://evil.example Cookie=invoiceops_session=x Host=invoiceops.aglai.dev)"
check "peer cookie write with wrong Origin is 403 FORBIDDEN_ORIGIN ($R)" '[[ $R == 403:FORBIDDEN_ORIGIN ]]'
R="$(peer POST http://invoiceops-web/api/v1/auth/logout 1 http://invoiceops-web Cookie=invoiceops_session=x)"
check "peer cannot pass using its own Host as Origin ($R)" '[[ $R == 403:FORBIDDEN_ORIGIN ]]'

section "7. No published host ports except edge-sim"
for service in db backend web; do
  id="$(dc ps -q "$service")"
  ports="$(docker port "$id" 2>/dev/null || true)"
  check "$service publishes no host port" '[[ -z $ports ]]'
done
edge_ports="$(docker port "$(dc ps -q edge-sim)")"
check "edge-sim publishes only 127.0.0.1:$PRODLIKE_HTTPS_PORT ($(echo "$edge_ports" | tr '\n' ' '))" \
  '[[ $edge_ports == *"127.0.0.1:$PRODLIKE_HTTPS_PORT"* && $edge_ports != *"0.0.0.0"* ]]'

section "8. Smoke script against the prod-like stack"
SIM_IP=203.0.113.30
echo "--- 8a. password via SMOKE_PASSWORD (host)"
SMOKE_PASSWORD="$ADMIN_NEW_PASSWORD" SMOKE_CACERT="$CERT" BASE_URL="$ORIGIN" \
  bash ops/smoke.sh "$ADMIN_RUT" && smoke=0 || smoke=1
check "ops/smoke.sh passes with SMOKE_PASSWORD (log above)" '((smoke == 0))'
echo "--- 8b. interactive prompt, SMOKE_PASSWORD unset, password fed on stdin"
printf '%s\n' "$ADMIN_NEW_PASSWORD" |
  env -u SMOKE_PASSWORD SMOKE_CACERT="$CERT" BASE_URL="$ORIGIN" bash ops/smoke.sh "$ADMIN_RUT" && smoke=0 || smoke=1
check "ops/smoke.sh passes in interactive mode (CR-401)" '((smoke == 0))'
echo "--- 8c. Ubuntu container without Node, on the edge network"
SMOKE_IMAGE=ubuntu:26.04
docker image inspect "$SMOKE_IMAGE" >/dev/null 2>&1 || docker pull -q "$SMOKE_IMAGE" >/dev/null 2>&1 || SMOKE_IMAGE=ubuntu:24.04
echo "      image: $SMOKE_IMAGE"
smoke_log="$(SMOKE_PASSWORD="$ADMIN_NEW_PASSWORD" docker run --rm --network "$INVOICEOPS_EDGE_NETWORK" \
  -v "$PWD/ops/smoke.sh:/smoke.sh:ro" -v "$CERT:/ca.pem:ro" \
  -e SMOKE_PASSWORD -e SMOKE_CACERT=/ca.pem -e BASE_URL="$ORIGIN" \
  -e SMOKE_CONNECT_TO="localhost:$PRODLIKE_HTTPS_PORT:edge-sim:443" \
  "$SMOKE_IMAGE" bash -c '
    set -e
    apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl python3-minimal ca-certificates >/dev/null 2>&1
    if command -v node >/dev/null; then echo "NODE PRESENT"; exit 3; fi
    echo "node: absent; $(curl --version | head -1); $(python3 --version)"
    bash /smoke.sh "$0"' "$ADMIN_RUT" 2>&1)" && smoke=0 || smoke=1
echo "$smoke_log" | tail -n 30
check "smoke ran without Node, via --connect-to, with Origin = PUBLIC_ORIGIN (CR-402)" \
  '((smoke == 0)) && [[ $smoke_log == *"node: absent"* && $smoke_log == *"SMOKE OK ($ORIGIN)"* ]]'

section "9. Persistence across restarts"
relogin_and_find_org() {
  http POST /api/v1/auth/login -c "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
    --data "$(login_payload "$ADMIN_RUT" "$ADMIN_NEW_PASSWORD")"
  login_status="$STATUS"
  http GET /api/v1/organizations -b "$JAR"
}
SIM_IP=203.0.113.40
dc down
dc up -d --wait
relogin_and_find_org
check "after down/up (volume kept): login works and the organization exists" '[[ $login_status == 200 && $BODY == *prodlike-org* ]]'
dc up -d --wait --force-recreate
relogin_and_find_org
check "after up --force-recreate: login works and the organization exists" '[[ $login_status == 200 && $BODY == *prodlike-org* ]]'

section "9b. A backend recreate that changes its IP must not leave web with a stale address (CR-403)"
# nginx resolves invoiceops-backend once. Docker normally hands the same IP back
# to the recreated container, so a filler container takes the freed address first.
# Only a plain `up -d` (no service names, no --no-deps) triggers
# depends_on.restart on web, which is why DEPLOY.md never targets one service.
backend_ip() { docker inspect -f '{{(index .NetworkSettings.Networks "invoiceops-prodlike_api").IPAddress}}' "$(dc ps -q backend)"; }
ip_before="$(backend_ip)"
web_before="$(docker inspect --format '{{.State.StartedAt}}' "$(dc ps -q web)")"
docker stop "$(dc ps -q backend)" >/dev/null
docker run -d --rm --name invoiceops-prodlike-ipfill --network invoiceops-prodlike_api node:24-alpine sleep 300 >/dev/null
PUBLIC_ORIGIN=https://localhost:9 dc up -d --wait
docker rm -f invoiceops-prodlike-ipfill >/dev/null
for _ in $(seq 1 30); do [[ "$(web_health)" == healthy ]] && break; sleep 2; done
ip_after="$(backend_ip)"
web_after="$(docker inspect --format '{{.State.StartedAt}}' "$(dc ps -q web)")"
echo "      backend IP $ip_before -> $ip_after; web StartedAt $web_before -> $web_after"
check "the backend really got a different IP" '[[ $ip_before != "$ip_after" ]]'
check "web was restarted by depends_on.restart" '[[ $web_before != "$web_after" ]]'
check "web is healthy again" '[[ "$(web_health)" == healthy ]]'
SIM_IP=203.0.113.41
http GET /api/v1/auth/profile
check "GET /api/v1/auth/profile is 401 (not 502) after the backend moved" '[[ $STATUS == 401 ]]'
# Back to the real configuration (this recreates the backend again).
dc up -d --wait
for _ in $(seq 1 30); do [[ "$(web_health)" == healthy ]] && break; sleep 2; done
http GET /api/v1/auth/profile
check "profile is 401 again after restoring PUBLIC_ORIGIN" '[[ $STATUS == 401 ]]'

section "9c. The application never connects as the database owner (CR-405)"
psql_owner() { dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$0"' "$1"; }
app_conns="$(psql_owner "select count(*) from pg_stat_activity where usename = '$APP_USER' and backend_type = 'client backend'")"
owner_conns="$(psql_owner "select count(*) from pg_stat_activity where usename = 'invoiceops' and backend_type = 'client backend' and pid <> pg_backend_pid() and client_addr is not null")"
check "backend holds connections as $APP_USER ($app_conns)" '((app_conns >= 1))'
check "no network connection is open as the owner ($owner_conns)" '((owner_conns == 0))'
attrs="$(psql_owner "select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = '$APP_USER'")"
check "$APP_USER is not superuser/createdb/createrole/replication/bypassrls ($attrs)" '[[ $attrs == "f|f|f|f|f" ]]'
as_app() { dc exec -T -e PGPASSWORD="$APP_PASSWORD" db psql -h 127.0.0.1 -U "$APP_USER" -d invoiceops -Atc "$1" 2>&1; }
create_out="$(as_app 'create table public.should_fail(i int)')" && create_rc=0 || create_rc=1
check "$APP_USER cannot CREATE TABLE in public ($create_out)" '((create_rc == 1)) && [[ $create_out == *"permission denied"* ]]'
drop_out="$(as_app 'drop table public."User"')" && drop_rc=0 || drop_rc=1
check "$APP_USER cannot DROP a table ($drop_out)" '((drop_rc == 1))'
users_out="$(as_app 'select count(*) from public."User"')" && users_rc=0 || users_rc=1
check "$APP_USER can read application tables ($users_out)" '((users_rc == 0))'

section "10. Images: no secrets, runtime content, non-root"
backend_image="invoiceops-backend:$INVOICEOPS_VERSION"
web_image="invoiceops-web:$INVOICEOPS_VERSION"
tooling_image="invoiceops-backend-tooling:$INVOICEOPS_VERSION"
secrets="$PG_PASSWORD,$ADMIN_TEMP_PASSWORD,$ADMIN_NEW_PASSWORD"
for image in "$backend_image" "$web_image" "$tooling_image"; do
  history="$(docker history --no-trunc "$image")"
  check "$image history has no secret" '[[ $history != *"$PG_PASSWORD"* && $history != *"$ADMIN_TEMP_PASSWORD"* && $history != *"$ADMIN_NEW_PASSWORD"* ]]'
  cid="$(docker create "$image" 2>/dev/null)"
  scan="$(docker export "$cid" | SECRETS="$secrets" node -e '
    const secrets = process.env.SECRETS.split(",").map((s) => Buffer.from(s));
    let tail = Buffer.alloc(0), found = false;
    process.stdin.on("data", (chunk) => {
      const buf = Buffer.concat([tail, chunk]);
      if (secrets.some((s) => buf.includes(s))) found = true;
      tail = buf.subarray(Math.max(0, buf.length - 128));
    });
    process.stdin.on("end", () => console.log(found ? "FOUND" : "CLEAN"));
  ')"
  docker rm "$cid" >/dev/null
  check "$image filesystem scan finds no secret ($scan)" '[[ $scan == CLEAN ]]'
done
dev_tools="$(docker run --rm --entrypoint sh "$backend_image" -c '
  for name in prisma tsx vitest typescript tsc; do
    [ -e "node_modules/$name" ] && echo "node_modules/$name"
    [ -e "node_modules/.bin/$name" ] && echo "node_modules/.bin/$name"
  done
  for name in tsx vitest; do
    for dir in node_modules/.pnpm/"$name"@*; do [ -e "$dir" ] && echo "$dir"; done
  done
  true' 2>/dev/null)"
check "runtime image links no prisma/tsx/vitest/typescript binary or package (${dev_tools:-none})" '[[ -z $dev_tools ]]'
# Informational: pnpm keeps transitive peers of @prisma/client in its virtual store.
echo "      note: .pnpm virtual store also holds: $(docker run --rm --entrypoint sh "$backend_image" -c 'ls node_modules/.pnpm | while read -r d; do case "$d" in prisma@*|typescript@*|dotenv@*) echo "${d%%_*}";; esac; done' 2>/dev/null | tr '\n' ' ')"
check "runtime image user is node" '[[ "$(docker inspect --format "{{.Config.User}}" "$backend_image")" == node ]]'
uid="$(dc exec -T backend id -u)"
check "backend process runs as uid $uid (not root)" '[[ $uid != 0 ]]'
# Ignore what the runtime itself adds: docker-init (init: true) and the rosetta
# cache that appears only when amd64 runs emulated on an arm64 host.
changes=""
while read -r kind path; do
  case "$path" in
    /sbin | /sbin/docker-init | /home | /home/node | /home/node/.cache | /home/node/.cache/rosetta*) ;;
    *) changes+="$kind $path; " ;;
  esac
done < <(docker diff "$(dc ps -q backend)")
check "backend wrote nothing to its filesystem (docker diff: ${changes:-empty})" '[[ -z $changes ]]'

section "11. Graceful stop of the backend (CR-414)"
backend_id="$(dc ps -q backend)"
stop_start=$SECONDS
docker stop "$backend_id" >/dev/null
stop_secs=$((SECONDS - stop_start))
stop_exit="$(docker inspect --format '{{.State.ExitCode}}' "$backend_id")"
stop_logs="$(docker logs "$backend_id" 2>&1)"
echo "      docker stop took ${stop_secs}s, exit code $stop_exit"
check "docker stop completes in < 5 s (${stop_secs}s)" '((stop_secs < 5))'
check "backend exited 0" '[[ $stop_exit == 0 ]]'
check "backend logged the clean shutdown line" '[[ $stop_logs == *"\"event\":\"shutdown\""*"\"outcome\":\"clean\""* ]]'
dc up -d --wait

section "Result"
if ((failures > 0)); then
  echo "PRODLIKE FAILED: $failures check(s). Stack kept for inspection; remove with: bash ops/prodlike/run.sh --down"
  exit 1
fi
echo "PRODLIKE OK. Stack kept for inspection at $ORIGIN; remove with: bash ops/prodlike/run.sh --down"
