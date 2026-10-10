// Agregador fictício em memória, com a API que o HttpAggregatorClient espera. Usado no `npm run dev`
// e nos testes do cliente. A rota /_demo simula a transportadora registrando eventos.

import { Hono } from "hono";

type Checkpoint = {
  checkpoint_id: string;
  time: string;
  courier_status: string;
  message?: string;
  city?: string;
  state?: string;
};

type Tracker = { tracker_id: string; code: string; courier: string; checkpoints: Checkpoint[] };

export function createFakeAggregator({ apiKey }: { apiKey: string }) {
  const trackers = new Map<string, Tracker>();
  const key = (courier: string, code: string) => `${courier}/${code}`;
  const app = new Hono();

  app.use("/v2/*", async (c, next) => {
    if (c.req.header("x-api-key") !== apiKey) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.post("/v2/trackers", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: string; courier?: string };
    if (!body.code || !body.courier) return c.json({ error: "code and courier are required" }, 400);
    if (trackers.has(key(body.courier, body.code))) return c.json({ error: "already exists" }, 409);
    const tracker = { tracker_id: `trk_${trackers.size + 1}`, code: body.code, courier: body.courier, checkpoints: [] };
    trackers.set(key(body.courier, body.code), tracker);
    return c.json({ data: tracker }, 201);
  });

  app.get("/v2/trackers/:courier/:code", (c) => {
    const tracker = trackers.get(key(c.req.param("courier"), c.req.param("code")));
    return tracker ? c.json({ data: tracker }) : c.json({ error: "not found" }, 404);
  });

  // Repetir o mesmo checkpoint_id simula reenvio.
  app.post("/_demo/trackers/:courier/:code/checkpoints", async (c) => {
    const tracker = trackers.get(key(c.req.param("courier"), c.req.param("code")));
    if (!tracker) return c.json({ error: "not found" }, 404);
    const checkpoint = (await c.req.json()) as Checkpoint;
    tracker.checkpoints.push(checkpoint);
    return c.json({ data: tracker }, 201);
  });

  return { app, trackers };
}
