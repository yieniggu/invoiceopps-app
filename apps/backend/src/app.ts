import express, { type ErrorRequestHandler } from "express";

import type { DatabaseReadiness } from "./database.js";

export function createApp(database: DatabaseReadiness) {
  const app = express();

  app.disable("x-powered-by");

  app.get("/health/live", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/health/ready", async (_request, response) => {
    let databaseReady = false;

    try {
      databaseReady = await database.isReady();
    } catch {
      databaseReady = false;
    }

    if (!databaseReady) {
      response.status(503).json({ status: "unavailable" });
      return;
    }

    response.status(200).json({ status: "ok" });
  });

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    console.error("Unhandled request error", error);
    response.status(500).json({ status: "error" });
  };

  app.use(errorHandler);

  return app;
}
