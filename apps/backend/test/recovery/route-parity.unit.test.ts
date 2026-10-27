import express from "express";
import { describe, expect, it } from "vitest";

import {
  compareRouteParity,
  enumerateMountedRoutes,
  enumerateOpenApiRoutes,
  normalizePath,
  routeKey,
} from "./route-parity.js";

// These tests validate the test-only helper itself; they are not evidence of
// the HTTP contract.
describe("route parity helper", () => {
  it("normalizes Express and OpenAPI parameters to one form", () => {
    expect(normalizePath("/invoices/:invoiceId")).toBe("/invoices/{invoiceId}");
    expect(normalizePath("/invoices/{invoiceId}")).toBe(
      "/invoices/{invoiceId}",
    );
    expect(normalizePath("/a/:x/b/:y/")).toBe("/a/{x}/b/{y}");
    expect(normalizePath("/")).toBe("/");
    expect(routeKey("post", "/a/:x")).toBe("POST /a/{x}");
  });

  it("enumerates app routes, ignoring HEAD, OPTIONS and the route-level all() marker", () => {
    const app = express();
    app.get("/a", () => {});
    app.post("/a/:id", () => {});
    app.route("/any").all(() => {});
    app
      .route("/r")
      .get(() => {})
      .patch(() => {});

    const keys = enumerateMountedRoutes(app).map((route) =>
      routeKey(route.method, route.path),
    );

    expect(keys.sort()).toEqual([
      "GET /a",
      "GET /r",
      "PATCH /r",
      "POST /a/{id}",
    ]);
  });

  it("recurses into nested routers using the mount prefix", () => {
    const nested = express.Router();
    nested.get("/items/:id", () => {});
    nested.get("/", () => {});
    const app = express();
    app.use("/api/v1", nested);
    app.use(express.Router().get("/rooted", () => {}));

    const keys = enumerateMountedRoutes(app).map((route) =>
      routeKey(route.method, route.path),
    );

    expect(keys.sort()).toEqual([
      "GET /api/v1",
      "GET /api/v1/items/{id}",
      "GET /rooted",
    ]);
  });

  it("fails loudly when a nested router mount cannot be determined", () => {
    const app = express();
    app.use(
      "/unknown",
      express.Router().get("/x", () => {}),
    );

    expect(() => enumerateMountedRoutes(app)).toThrow(/mount path/);
  });

  it("lists OpenAPI operations and ignores non-method keys", () => {
    const routes = enumerateOpenApiRoutes({
      paths: {
        "/a": { get: {}, parameters: [], post: {} },
        "/b/{id}": { delete: {} },
      },
    });

    expect(routes).toEqual([
      { method: "GET", path: "/a" },
      { method: "POST", path: "/a" },
      { method: "DELETE", path: "/b/{id}" },
    ]);
  });

  it("reports undocumented and phantom routes and honours exclusions", () => {
    const result = compareRouteParity({
      mounted: [
        { method: "GET", path: "/health/live" },
        { method: "GET", path: "/openapi.json" },
        { method: "GET", path: "/x/:id" },
        { method: "POST", path: "/ghost" },
      ],
      documented: [
        { method: "GET", path: "/x/{id}" },
        { method: "GET", path: "/phantom" },
      ],
      legacy: [{ method: "DELETE", path: "/legacy/:id" }],
    });

    expect(result.undocumented).toEqual(["POST /ghost"]);
    expect(result.phantom.sort()).toEqual([
      "DELETE /legacy/{id}",
      "GET /phantom",
    ]);
  });
});
