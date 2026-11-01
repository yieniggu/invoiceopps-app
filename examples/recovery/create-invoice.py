#!/usr/bin/env python3
"""Cliente de aula: crea y lee una factura con un token de API (solo stdlib).

Uso:
  create-invoice.py create --base-url URL --organization-id UUID [--group-id UUID]
  create-invoice.py get    --base-url URL --organization-id UUID --invoice-id UUID [--group-id UUID]

El token (iop_...) se lee SIN eco: variable INVOICEOPS_TOKEN, o prompt
silencioso en una terminal, o la primera linea de la entrada estandar.
Nunca se acepta como argumento ni se escribe en disco ni se imprime.
Solo se aceptan URLs base de loopback (127.0.0.1, localhost, ::1).
INVOICEOPS_TIMEOUT_SECONDS (opcional, defecto 15) acota cada peticion.
"""

import argparse
import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
TOKEN_PATTERN = re.compile(r"^iop_[A-Za-z0-9_-]{20,}$")
DEFAULT_TIMEOUT_SECONDS = 15
# Fijado por main() tras validar INVOICEOPS_TIMEOUT_SECONDS.
timeout_seconds = DEFAULT_TIMEOUT_SECONDS

EXIT_UNEXPECTED = 1
EXIT_USAGE = 2
EXIT_REJECTED_URL = 3

STATUS_MESSAGES = {
    400: "400 solicitud invalida: revisa la clave de idempotencia (16 a 128 caracteres A-Z a-z 0-9 _ -) y los campos de la factura",
    401: "401 no autenticado: el token es invalido, expiro o fue revocado; emite uno nuevo en «Tokens de API»",
    403: "403 sin permiso: al token le falta el alcance o a tu membresia el permiso para esta organizacion o grupo",
    404: "404 no encontrado: revisa los identificadores de organizacion y grupo (copialos desde la aplicacion web)",
    409: "409 conflicto: la clave ya se uso con otra carga o el businessId ya existe; no reintentes a ciegas",
    410: "410 la factura creada con esta clave fue eliminada; no se restaura ni se recrea",
    429: "429 demasiadas solicitudes; espera unos minutos e inténtalo de nuevo",
    503: "503 servicio ocupado: espera un momento y reintenta con la MISMA clave y la MISMA carga",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# Sin proxies y sin redirecciones: el token solo viaja al loopback indicado.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def fail(message, code=EXIT_UNEXPECTED):
    print(message, file=sys.stderr)
    sys.exit(code)


def validate_base_url(value):
    parsed = urllib.parse.urlsplit(value)
    try:
        hostname = parsed.hostname
        parsed.port
    except ValueError:
        hostname = None
    ok = (
        parsed.scheme in ("http", "https")
        and hostname in LOOPBACK_HOSTS
        and parsed.username is None
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment
    )
    if not ok:
        fail(
            "URL base rechazada: solo se permiten 127.0.0.1, localhost o ::1 "
            "(ej. http://127.0.0.1:4000)",
            EXIT_REJECTED_URL,
        )
    return value.rstrip("/")


def validate_uuid(name, value):
    try:
        canonical = str(uuid.UUID(value))
    except ValueError:
        canonical = None
    # Solo la forma canonica 8-4-4-4-12 (sin llaves, urn: ni guiones omitidos).
    if canonical is None or canonical != value.lower():
        fail(f"{name} debe ser un UUID copiado desde la aplicacion web", EXIT_USAGE)


def read_timeout():
    raw = os.environ.get("INVOICEOPS_TIMEOUT_SECONDS") or str(DEFAULT_TIMEOUT_SECONDS)
    if not re.fullmatch(r"[0-9]+", raw, re.ASCII) or int(raw) < 1:
        fail(
            "INVOICEOPS_TIMEOUT_SECONDS debe ser un entero positivo (segundos)",
            EXIT_USAGE,
        )
    return int(raw)


def read_token():
    token = os.environ.get("INVOICEOPS_TOKEN")
    if token is None:
        if sys.stdin.isatty():
            token = getpass.getpass("Token de API (no se muestra): ")
        else:
            token = sys.stdin.readline()
    token = token.strip()
    if not TOKEN_PATTERN.match(token):
        fail("Token ausente o con formato invalido (se espera iop_...).", EXIT_USAGE)
    return token


def call(method, url, token, body=None, key=None):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
        headers["Idempotency-Key"] = key
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with OPENER.open(request, timeout=timeout_seconds) as response:
            status, raw, response_headers = (
                response.status,
                response.read(),
                response.headers,
            )
    except urllib.error.HTTPError as error:
        status, raw, response_headers = error.code, error.read(), error.headers
    except (urllib.error.URLError, TimeoutError, OSError):
        message = "No hubo respuesta del servidor (red o tiempo agotado)."
        if key:
            message += f" Reintenta con la MISMA clave de idempotencia: {key}"
        fail(message)
    try:
        payload = json.loads(raw) if raw else {}
    except ValueError:
        payload = {}
    return status, payload, response_headers


def expect(step, status, wanted):
    if status == wanted:
        return
    detail = STATUS_MESSAGES.get(status, f"{status} respuesta inesperada")
    fail(f"[{step}] {detail}")


def show(step, status, invoice, extra=""):
    print(
        f"[{step}] HTTP {status} id={invoice['id']} businessId={invoice['businessId']} "
        f"monto={invoice['amountPesos']} {invoice['currency']}{extra}"
    )


def build_invoice(args):
    invoice = {
        "organizationId": args.organization_id,
        "businessId": args.business_id,
        "supplierName": args.supplier_name,
        "amountPesos": args.amount_pesos,
        "currency": "CLP",
        "issuedOn": args.issued_on,
        "dueOn": args.due_on,
        "businessStatus": "PENDING",
    }
    if args.group_id:
        invoice["groupId"] = args.group_id
    return invoice


def scope_query(args):
    query = {"organizationId": args.organization_id}
    if args.group_id:
        query["groupId"] = args.group_id
    return urllib.parse.urlencode(query)


def run_get(args, base, token):
    path = f"/api/v1/invoices/{urllib.parse.quote(args.invoice_id)}?{scope_query(args)}"
    status, payload, _ = call("GET", base + path, token)
    expect("GET", status, 200)
    show("GET", status, payload["invoice"])


def run_create(args, base, token):
    key = args.idempotency_key or f"clase-{uuid.uuid4().hex}"
    print(f"Clave de idempotencia: {key}")
    body = build_invoice(args)
    url = base + "/api/v1/invoices"

    status, payload, headers = call("POST", url, token, body, key)
    expect("crear", status, 201)
    created = payload["invoice"]
    show("crear", status, created)
    location = headers.get("Location", "")
    if not location.startswith("/api/v1/invoices/"):
        fail("[crear] la respuesta no trae un Location valido")

    status, payload, headers = call("POST", url, token, body, key)
    expect("repetir", status, 201)
    if payload["invoice"]["id"] != created["id"]:
        fail("[repetir] la misma clave y carga devolvio otra factura")
    replayed = headers.get("Idempotency-Replayed") == "true"
    show("repetir", status, payload["invoice"], f" replay={str(replayed).lower()}")

    other = dict(body, amountPesos=body["amountPesos"] + 1)
    status, _, _ = call("POST", url, token, other, key)
    if status != 409:
        expect("conflicto", status, 409)
    print("[conflicto] HTTP 409 esperado: misma clave con otra carga; no se reintenta")

    status, payload, _ = call("GET", base + location, token)
    expect("GET", status, 200)
    if payload["invoice"]["id"] != created["id"]:
        fail("[GET] el Location devolvio otra factura")
    show("GET", status, payload["invoice"], " (via Location)")


def parser():
    root = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = root.add_subparsers(dest="command", required=True)
    for name in ("create", "get"):
        command = sub.add_parser(name)
        command.add_argument("--base-url", required=True)
        command.add_argument("--organization-id", required=True)
        command.add_argument("--group-id")
        if name == "get":
            command.add_argument("--invoice-id", required=True)
        else:
            command.add_argument("--business-id", default=f"FAC-{uuid.uuid4().hex[:8]}")
            command.add_argument("--supplier-name", default="Proveedor local")
            command.add_argument("--amount-pesos", type=int, default=12500)
            command.add_argument("--issued-on", default="2026-10-25")
            command.add_argument("--due-on", default="2026-11-25")
            command.add_argument("--idempotency-key")
    return root


def main():
    args = parser().parse_args()
    global timeout_seconds
    base = validate_base_url(args.base_url)
    validate_uuid("organization-id", args.organization_id)
    if args.group_id:
        validate_uuid("group-id", args.group_id)
    if args.command == "get":
        validate_uuid("invoice-id", args.invoice_id)
    timeout_seconds = read_timeout()
    token = read_token()
    (run_create if args.command == "create" else run_get)(args, base, token)


if __name__ == "__main__":
    main()
