import type { DatabaseSync } from "node:sqlite";
import { type Context, Hono } from "hono";
import type { TrackingProvider } from "./aggregator/types.ts";
import { type Clock, systemClock } from "./clock.ts";
import { DomainError } from "./errors.ts";
import { createShipmentService, type Logger, type Notifier } from "./shipments.ts";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError("json_invalido", "O corpo precisa ser um JSON válido.", 400);
  }
}

export function createApp(deps: {
  db: DatabaseSync;
  provider: TrackingProvider;
  clock?: Clock;
  notifier?: Notifier;
  logger?: Logger;
  defaultMaxTransitDays?: number;
}) {
  const shipments = createShipmentService({ ...deps, clock: deps.clock ?? systemClock });
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof DomainError) return c.json(error.toJSON(), error.status);
    console.error(error);
    return c.json({ error: "erro_interno", message: "Erro inesperado." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/shipments", async (c) => {
    const out = await shipments.register(await readJson(c));
    return c.json(out.shipment, out.created ? 201 : 200);
  });
  app.get("/shipments/:id", (c) => c.json(shipments.get(c.req.param("id"))));
  app.post("/shipments/:id/refresh", async (c) => c.json(await shipments.refresh(c.req.param("id"))));

  app.post("/webhooks/aggregator", async (c) => c.json(shipments.ingestWebhook(await readJson(c))));

  app.post("/jobs/check-delays", async (c) => c.json(await shipments.checkDelays()));
  app.get("/alerts", (c) => c.json(shipments.listAlerts(c.req.query("open") === "true")));

  return app;
}
