import { createRequire } from "node:module";

import { Router, type Response } from "express";

const require = createRequire(import.meta.url);

/**
 * Absolute path of the locally installed swagger-ui-dist package. The UI is
 * always served from here: no CDN, so the page works offline and a third party
 * never sees who opens the API documentation.
 */
const DIST_PATH: string = (
  require("swagger-ui-dist") as { getAbsoluteFSPath: () => string }
).getAbsoluteFSPath();

/**
 * The only files of the package that are published. The package also ships an
 * index.html that points at the public petstore, a second initializer and
 * source maps: none of them is reachable.
 */
const DIST_ASSETS = [
  "swagger-ui.css",
  "swagger-ui-bundle.js",
  "favicon-16x16.png",
  "favicon-32x32.png",
] as const;

/** The dist files are pinned by the lockfile, so an hour is a safe cache. */
const ASSET_CACHE_CONTROL = "public, max-age=3600";
const REVALIDATE = "no-cache";

export const DOCS_PATH = "/docs";

/** Page that mounts Swagger UI; every script is an external file (no inline). */
const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>InvoiceOps API</title>
    <link rel="icon" type="image/png" href="${DOCS_PATH}/favicon-32x32.png" sizes="32x32" />
    <link rel="icon" type="image/png" href="${DOCS_PATH}/favicon-16x16.png" sizes="16x16" />
    <link rel="stylesheet" href="${DOCS_PATH}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${DOCS_PATH}/swagger-ui-bundle.js"></script>
    <script src="${DOCS_PATH}/swagger-initializer.js"></script>
  </body>
</html>
`;

/**
 * Our own initializer, served in place of the one inside swagger-ui-dist.
 * The document is the same-origin /openapi.json; the pasted token lives in
 * memory only (a reload logs out), the online validator badge is off, and
 * requests never carry cookies (credentials "omit"): only the typed token.
 */
const INITIALIZER_JS = `window.addEventListener("load", function () {
  window.ui = SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    persistAuthorization: false,
    validatorUrl: null,
    tryItOutEnabled: false,
    withCredentials: false,
    // swagger-client defaults to credentials "same-origin", which would send
    // the app's session cookie next to the Bearer (400 AMBIGUOUS_AUTH). The
    // interceptor runs for the spec fetch and every Try it out request, and
    // swagger-client passes the request object to fetch, so "omit" is honored.
    requestInterceptor: function (request) {
      request.credentials = "omit";
      return request;
    },
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
  });
});
`;

/**
 * Policy of every response under /docs. The page and the initializer are
 * external same-origin scripts, so scripts stay on 'self' (no inline, no
 * eval; the bundle's `new Function` probe is caught and falls back). Swagger
 * UI styles elements inline and embeds data: images; nothing else is allowed,
 * and the page cannot be framed.
 */
export const DOCS_CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

function send(
  response: Response,
  contentType: string,
  cacheControl: string,
  body: string,
) {
  response
    .status(200)
    .type(contentType)
    .set("Cache-Control", cacheControl)
    .send(body);
}

/** Public Swagger UI (no authentication), mounted outside the API prefix. */
export function createDocsRouter(): Router {
  const router = Router({ caseSensitive: true, strict: true });

  // Path-scoped, so only /docs and /docs/* get it (not /docsx, not the API).
  router.use(DOCS_PATH, (_request, response, next) => {
    response.set("Content-Security-Policy", DOCS_CONTENT_SECURITY_POLICY);
    next();
  });

  router.get(DOCS_PATH, (_request, response) => {
    response.redirect(301, `${DOCS_PATH}/`);
  });
  router.get(`${DOCS_PATH}/`, (_request, response) => {
    send(response, "text/html; charset=utf-8", REVALIDATE, DOCS_HTML);
  });
  router.get(`${DOCS_PATH}/swagger-initializer.js`, (_request, response) => {
    send(
      response,
      "application/javascript; charset=utf-8",
      REVALIDATE,
      INITIALIZER_JS,
    );
  });
  for (const name of DIST_ASSETS) {
    router.get(`${DOCS_PATH}/${name}`, (_request, response, next) => {
      // `root` keeps the dotfile check relative to the package (pnpm stores it
      // under a `.pnpm` directory).
      response.sendFile(
        name,
        { root: DIST_PATH, headers: { "Cache-Control": ASSET_CACHE_CONTROL } },
        (error) => {
          if (error) next(error);
        },
      );
    });
  }

  return router;
}
