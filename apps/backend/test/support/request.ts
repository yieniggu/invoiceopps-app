import { createServer, type RequestListener, type Server } from "node:http";

import supertest from "supertest";
import { afterAll } from "vitest";

export type { Response, Test } from "supertest";

// Why not plain supertest(app): it opens a fresh `app.listen(0)` per request.
// That listener binds the wildcard address while supertest connects to
// 127.0.0.1:<port>, and under load a request intermittently reaches the wrong
// listener ("expected 404 to be 200") or is reset ("socket hang up").
// Ablation (bare express + supertest, 30 concurrent workers, 3000 requests per
// run, macOS, Node 24): plain supertest and plain supertest with only
// http.globalAgent keepAlive disabled both showed failures in 2 of 4 runs
// (4 wrong statuses plus 1 error per failing run); a listener bound explicitly
// to 127.0.0.1, with or without the agent change, showed none in 8 runs
// (24000 requests). The kernel-level mechanism was not isolated; the evidence
// supports "bind to 127.0.0.1", not the keep-alive agent.
//
// So this module owns ONE loopback listener per test file, bound to 127.0.0.1
// before any test runs (top-level await). Each `request(app)` tags its requests
// with an app id and the listener dispatches to that app, so every test still
// gets an isolated app and no listener is opened per request.
const APP_HEADER = "x-test-app-id";
const apps = new Map<string, RequestListener>();
const ids = new WeakMap<object, string>();
let nextId = 0;

const dispatcher: Server = createServer((request, response) => {
  const id = String(request.headers[APP_HEADER]);
  delete request.headers[APP_HEADER];
  const app = apps.get(id);
  if (!app) {
    response.statusCode = 500;
    response.end("unknown test app");
    return;
  }
  app(request, response);
});
await new Promise<void>((resolve) =>
  dispatcher.listen(0, "127.0.0.1", resolve),
);

afterAll(async () => {
  apps.clear();
  await new Promise<void>((resolve) => {
    dispatcher.closeAllConnections();
    dispatcher.close(() => resolve());
  });
});

const METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;

export default function request(app: RequestListener) {
  let id = ids.get(app);
  if (!id) {
    id = String((nextId += 1));
    ids.set(app, id);
    apps.set(id, app);
  }
  const base = supertest(dispatcher);
  const tagged = {} as Record<
    (typeof METHODS)[number],
    (url: string) => supertest.Test
  >;
  for (const method of METHODS) {
    tagged[method] = (url: string) => base[method](url).set(APP_HEADER, id);
  }
  return tagged;
}
