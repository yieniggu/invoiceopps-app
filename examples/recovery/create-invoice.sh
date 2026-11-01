#!/usr/bin/env bash
# Cliente de aula: crea y lee una factura con un token de API (bash + curl).
#
# Uso:
#   create-invoice.sh create --base-url URL --organization-id UUID [--group-id UUID]
#   create-invoice.sh get    --base-url URL --organization-id UUID --invoice-id UUID [--group-id UUID]
#
# El token (iop_...) se lee SIN eco: variable INVOICEOPS_TOKEN, o prompt
# silencioso en una terminal, o la primera linea de la entrada estandar.
# Nunca es un argumento, no se escribe en disco ni se imprime; curl recibe la
# cabecera Authorization por stdin (--config -), asi que no aparece en `ps`.
# Solo se aceptan URLs base de loopback (127.0.0.1, localhost, ::1).
# INVOICEOPS_TIMEOUT_SECONDS (opcional, defecto 15) acota cada peticion.
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  fail "Uso: $0 {create|get} --base-url URL --organization-id UUID [--group-id UUID] ..." 2
}

command_name="${1:-}"
[[ "$command_name" == "create" || "$command_name" == "get" ]] || usage
shift

base_url="" organization_id="" group_id="" invoice_id="" idempotency_key=""
business_id="FAC-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
supplier_name="Proveedor local" amount_pesos=12500
issued_on="2026-10-25" due_on="2026-11-25"

while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --base-url) base_url="$2" ;;
    --organization-id) organization_id="$2" ;;
    --group-id) group_id="$2" ;;
    --invoice-id) invoice_id="$2" ;;
    --business-id) business_id="$2" ;;
    --supplier-name) supplier_name="$2" ;;
    --amount-pesos) amount_pesos="$2" ;;
    --issued-on) issued_on="$2" ;;
    --due-on) due_on="$2" ;;
    --idempotency-key) idempotency_key="$2" ;;
    *) usage ;;
  esac
  shift 2
done

[[ -n "$base_url" && -n "$organization_id" ]] || usage
[[ "$command_name" == "create" || -n "$invoice_id" ]] || usage

# 1. Solo loopback; se decide antes de leer el token o abrir la red.
if [[ ! "$base_url" =~ ^https?://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?/?$ ]]; then
  fail "URL base rechazada: solo se permiten 127.0.0.1, localhost o ::1 (ej. http://127.0.0.1:4000)" 3
fi
base_url="${base_url%/}"

uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
[[ "$organization_id" =~ $uuid_pattern && ( -z "$group_id" || "$group_id" =~ $uuid_pattern ) ]] ||
  fail "organization-id y group-id deben ser UUID copiados desde la aplicacion web" 2
[[ -z "$invoice_id" || "$invoice_id" =~ $uuid_pattern ]] ||
  fail "invoice-id debe ser un UUID copiado desde la aplicacion web" 2
[[ "$amount_pesos" =~ ^[0-9]+$ ]] || fail "amount-pesos debe ser un entero en pesos" 2
[[ "$business_id$supplier_name$issued_on$due_on$idempotency_key" != *[\"\\]* ]] ||
  fail "Los textos no pueden contener comillas ni barras invertidas" 2

timeout_seconds="${INVOICEOPS_TIMEOUT_SECONDS:-15}"
[[ "$timeout_seconds" =~ ^[0-9]+$ && -n "${timeout_seconds//0/}" ]] ||
  fail "INVOICEOPS_TIMEOUT_SECONDS debe ser un entero positivo (segundos)" 2

# 2. Token sin eco.
token="${INVOICEOPS_TOKEN:-}"
if [[ -z "$token" ]]; then
  if [[ -t 0 ]]; then
    read -rsp "Token de API (no se muestra): " token
    echo >&2
  else
    IFS= read -r token || true
  fi
fi
token="${token//[[:space:]]/}"
[[ "$token" =~ ^iop_[A-Za-z0-9_-]{20,}$ ]] || fail "Token ausente o con formato invalido (se espera iop_...)." 2

scope_query="organizationId=${organization_id}"
[[ -z "$group_id" ]] || scope_query+="&groupId=${group_id}"

response_status="" response_location="" response_replayed="" response_body=""

# request METHOD URL [JSON_BODY KEY]: deja status, Location, replay y cuerpo.
request() {
  local method="$1" url="$2" body="${3:-}" key="${4:-}" output
  local args=(--silent --show-error --include --noproxy '*' --max-time "$timeout_seconds"
    --request "$method" --header "Accept: application/json" --config -)
  if [[ -n "$body" ]]; then
    args+=(--header "Content-Type: application/json"
      --header "Idempotency-Key: ${key}" --data-binary "$body")
  fi
  # La credencial viaja por stdin (config en memoria), nunca por argv.
  if ! output="$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl "${args[@]}" "$url")"; then
    local message="No hubo respuesta del servidor (red o tiempo agotado)."
    [[ -z "$key" ]] || message+=" Reintenta con la MISMA clave de idempotencia: ${key}"
    fail "$message"
  fi
  output="${output//$'\r'/}"
  response_status="${output#HTTP/* }"
  response_status="${response_status%% *}"
  response_location="" response_replayed=""
  local headers="${output%%$'\n\n'*}" line lower
  while IFS= read -r line; do
    lower="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      location:*) response_location="${line#*: }" ;;
      idempotency-replayed:*) response_replayed="${line#*: }" ;;
    esac
  done <<<"$headers"
  response_body="${output#*$'\n\n'}"
}

expect() {
  local step="$1" wanted="$2" detail
  [[ "$response_status" == "$wanted" ]] && return 0
  case "$response_status" in
    400) detail="400 solicitud invalida: revisa la clave de idempotencia (16 a 128 caracteres A-Z a-z 0-9 _ -) y los campos de la factura" ;;
    401) detail="401 no autenticado: el token es invalido, expiro o fue revocado; emite uno nuevo en «Tokens de API»" ;;
    403) detail="403 sin permiso: al token le falta el alcance o a tu membresia el permiso para esta organizacion o grupo" ;;
    404) detail="404 no encontrado: revisa los identificadores de organizacion y grupo (copialos desde la aplicacion web)" ;;
    409) detail="409 conflicto: la clave ya se uso con otra carga o el businessId ya existe; no reintentes a ciegas" ;;
    410) detail="410 la factura creada con esta clave fue eliminada; no se restaura ni se recrea" ;;
    429) detail="429 demasiadas solicitudes; espera unos minutos e inténtalo de nuevo" ;;
    503) detail="503 servicio ocupado: espera un momento y reintenta con la MISMA clave y la MISMA carga" ;;
    *) detail="${response_status} respuesta inesperada" ;;
  esac
  fail "[${step}] ${detail}"
}

json_field() { # json_field NOMBRE: valor de un campo simple del JSON compacto
  local pattern="\"$1\":(\"([^\"]*)\"|([0-9]+))"
  [[ "$response_body" =~ $pattern ]] || return 1
  printf '%s' "${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
}

show() { # show PASO [EXTRA]
  printf '[%s] HTTP %s id=%s businessId=%s monto=%s %s%s\n' "$1" "$response_status" \
    "$(json_field id)" "$(json_field businessId)" "$(json_field amountPesos)" \
    "$(json_field currency)" "${2:-}"
}

invoice_json() {
  local group_part=""
  [[ -z "$group_id" ]] || group_part="\"groupId\":\"${group_id}\","
  printf '{"organizationId":"%s",%s"businessId":"%s","supplierName":"%s","amountPesos":%s,"currency":"CLP","issuedOn":"%s","dueOn":"%s","businessStatus":"PENDING"}' \
    "$organization_id" "$group_part" "$business_id" "$supplier_name" "$1" "$issued_on" "$due_on"
}

if [[ "$command_name" == "get" ]]; then
  request GET "${base_url}/api/v1/invoices/${invoice_id}?${scope_query}"
  expect GET 200
  show GET
  exit 0
fi

[[ -n "$idempotency_key" ]] || idempotency_key="clase-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
echo "Clave de idempotencia: ${idempotency_key}"
invoices_url="${base_url}/api/v1/invoices"

request POST "$invoices_url" "$(invoice_json "$amount_pesos")" "$idempotency_key"
expect crear 201
show crear
created_id="$(json_field id)"
location="$response_location"
[[ "$location" == /api/v1/invoices/* ]] || fail "[crear] la respuesta no trae un Location valido"

request POST "$invoices_url" "$(invoice_json "$amount_pesos")" "$idempotency_key"
expect repetir 201
[[ "$(json_field id)" == "$created_id" ]] || fail "[repetir] la misma clave y carga devolvio otra factura"
show repetir " replay=$([[ "$response_replayed" == "true" ]] && echo true || echo false)"

request POST "$invoices_url" "$(invoice_json "$((amount_pesos + 1))")" "$idempotency_key"
expect conflicto 409
echo "[conflicto] HTTP 409 esperado: misma clave con otra carga; no se reintenta"

request GET "${base_url}${location}"
expect GET 200
[[ "$(json_field id)" == "$created_id" ]] || fail "[GET] el Location devolvio otra factura"
show GET " (via Location)"
