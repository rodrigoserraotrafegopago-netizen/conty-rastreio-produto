import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createFakeAggregator } from "./aggregator/fake-server.ts";
import { HttpAggregatorClient } from "./aggregator/http-client.ts";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const port = Number(process.env.PORT || 3007);
const db = openDatabase(process.env.DB_PATH || "data/rastreio.sqlite");

// Sem AGGREGATOR_URL, o agregador fictício sobe no mesmo processo e o cliente fala com ele por HTTP.
const useFake = !process.env.AGGREGATOR_URL;
const apiKey = process.env.AGGREGATOR_API_KEY || "dev-key";
const provider = new HttpAggregatorClient({
  baseUrl: process.env.AGGREGATOR_URL || `http://127.0.0.1:${port}/_fake-aggregator`,
  apiKey,
});

const app = createApp({ db, provider, defaultMaxTransitDays: Number(process.env.DEFAULT_MAX_TRANSIT_DAYS || 7) });
const root = new Hono();
if (useFake) root.route("/_fake-aggregator", createFakeAggregator({ apiKey }).app);
root.route("/", app);

// Em produção seria um cron chamando POST /jobs/check-delays.
const checkEveryMinutes = Number(process.env.DELAY_CHECK_INTERVAL_MINUTES || 60);
setInterval(() => {
  Promise.resolve(app.request("/jobs/check-delays", { method: "POST" })).catch((error: unknown) =>
    console.error(error),
  );
}, checkEveryMinutes * 60_000);

serve({ fetch: root.fetch, port }, (info) => {
  console.log(
    `rastreio em http://127.0.0.1:${info.port}${useFake ? " (agregador fictício em /_fake-aggregator)" : ""}`,
  );
});
