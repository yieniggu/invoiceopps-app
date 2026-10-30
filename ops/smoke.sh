#!/usr/bin/env bash
# Non-destructive smoke test against a running InvoiceOps deployment.
#
#   BASE_URL=https://invoiceops.aglai.dev ops/smoke.sh [RUT]
#
# RUT comes from the first argument or SMOKE_RUT. The password is read from a
# silent prompt (or SMOKE_PASSWORD for automation); it is handed to the JSON
# builder and to curl through pipes, never through argv. The user must NOT
# have a pending temporary password. Creates no data: it only reads, tries one
# forged-Origin write (must be rejected) and logs out.
# Requires: bash, curl, python3 (no Node). Works from the server or from any
# machine that can reach BASE_URL.
# SMOKE_CACERT=<file> trusts an extra CA; SMOKE_CONNECT_TO=<curl --connect-to
# value> routes the request elsewhere while URL and Origin stay BASE_URL
# (both used by ops/prodlike/run.sh).
set -euo pipefail

BASE_URL="${BASE_URL:-https://invoiceops.aglai.dev}"
BASE_URL="${BASE_URL%/}"
RUT="${1:-${SMOKE_RUT:-}}"
[[ -n "$RUT" ]] || { echo "usage: ops/smoke.sh <RUT>  (or SMOKE_RUT)" >&2; exit 2; }
if [[ -z "${SMOKE_PASSWORD:-}" ]]; then
  read -r -s -p "Password for $RUT: " SMOKE_PASSWORD
  echo
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
jar="$work/jar"
curl_args=(-sS --max-time 20)
[[ -z "${SMOKE_CACERT:-}" ]] || curl_args+=(--cacert "$SMOKE_CACERT")
[[ -z "${SMOKE_CONNECT_TO:-}" ]] || curl_args+=(--connect-to "$SMOKE_CONNECT_TO")

failures=0
STATUS="" BODY="" HEADERS=""
# http METHOD PATH [curl args...] -> sets STATUS, BODY and HEADERS (lower-case).
http() {
  local method="$1" path="$2"
  shift 2
  STATUS="$(curl "${curl_args[@]}" -X "$method" -o "$work/body" -D "$work/headers" \
    -w '%{http_code}' "$@" "$BASE_URL$path" || true)"
  BODY="$(tr -d '\r' < "$work/body")"
  HEADERS="$(tr -d '\r' < "$work/headers" | tr '[:upper:]' '[:lower:]')"
}
# check "name" '<bash [[ ]] expression>' (evaluated against the last response)
check() {
  if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}

# Hardening headers every response must carry (nginx `always` headers).
has_security_headers() {
  [[ $HEADERS == *"x-content-type-options: nosniff"* &&
    $HEADERS == *"x-frame-options: deny"* &&
    $HEADERS == *"referrer-policy: same-origin"* &&
    $HEADERS == *"strict-transport-security: max-age=31536000"* &&
    $HEADERS != *"includesubdomains"* ]]
}
# No `Server: nginx/<version>` (behind Cloudflare the header is replaced anyway).
hides_server_version() {
  [[ $HEADERS != *"server: nginx/"* ]]
}

http GET /
INDEX="$BODY"
check "GET / is the app (200 with a script tag)" '[[ $STATUS == 200 && $BODY == *"<script"* ]]'
check "GET / carries the security headers" has_security_headers
check "GET / hides the nginx version" hides_server_version
check "GET / is revalidated (Cache-Control: no-cache)" '[[ $HEADERS == *"cache-control: no-cache"* ]]'

ASSET=""
for token in ${INDEX//\"/ }; do
  if [[ "$token" == /assets/*.js ]]; then ASSET="$token"; break; fi
done
http GET "${ASSET:-/assets/missing.js}"
check "GET ${ASSET:-/assets/*.js} is JavaScript (200)" '[[ $STATUS == 200 && $HEADERS == *"content-type:"*javascript* ]]'
check "asset carries the security headers" has_security_headers
check "asset is cached as immutable" '[[ $HEADERS == *"cache-control: public, max-age=31536000, immutable"* ]]'

http GET /admin/users
check "deep SPA route serves index.html" '[[ $STATUS == 200 && $BODY == "$INDEX" ]]'

http GET /healthz
check "GET /healthz is ok" '[[ $STATUS == 200 && $BODY == ok ]]'

http GET /api/v1/auth/profile
check "unauthenticated API read is 401 JSON" '[[ $STATUS == 401 && $BODY == *UNAUTHENTICATED* ]]'
check "API response carries the security headers" has_security_headers

http GET /openapi.json
check "GET /openapi.json is 200" '[[ $STATUS == 200 && $BODY == *\"openapi\"* ]]'

# The password travels printf (builtin) -> python3 stdin -> curl stdin, never argv.
login_body() {
  printf '%s' "$SMOKE_PASSWORD" |
    python3 -c 'import json, sys; sys.stdout.write(json.dumps({"rut": sys.argv[1], "password": sys.stdin.read()}))' "$RUT"
}
http POST /api/v1/auth/login -c "$jar" -H "Origin: $BASE_URL" \
  -H 'Content-Type: application/json' --data @- < <(login_body)
check "login is 200" '[[ $STATUS == 200 ]]'
check "session cookie is Secure, HttpOnly, SameSite=Lax" \
  '[[ $HEADERS == *"set-cookie:"*"; secure"* && $HEADERS == *"; httponly"* && $HEADERS == *"samesite=lax"* ]]'

http GET /api/v1/auth/profile -b "$jar"
check "session read is 200 without a pending password change" \
  '[[ $STATUS == 200 && $BODY == *\"mustChangePassword\":false* ]]'

http POST /api/v1/auth/logout -b "$jar" -H 'Origin: https://evil.example'
check "forged-Origin write is rejected (403 FORBIDDEN_ORIGIN)" \
  '[[ $STATUS == 403 && $BODY == *FORBIDDEN_ORIGIN* ]]'

http GET /api/v1/auth/profile -b "$jar"
check "session survived the forged write" '[[ $STATUS == 200 ]]'

http POST /api/v1/auth/logout -b "$jar" -H "Origin: $BASE_URL"
check "logout with the correct Origin succeeds (2xx)" '[[ $STATUS == 2* ]]'

http GET /api/v1/auth/profile -b "$jar"
check "session is gone after logout (401)" '[[ $STATUS == 401 ]]'

if ((failures > 0)); then
  echo "SMOKE FAILED: $failures check(s)" >&2
  exit 1
fi
echo "SMOKE OK ($BASE_URL)"
