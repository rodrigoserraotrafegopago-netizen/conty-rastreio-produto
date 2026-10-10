import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  carrier TEXT NOT NULL,
  tracking_code TEXT NOT NULL,
  campaign_id TEXT,
  creator_id TEXT,
  max_transit_days INTEGER NOT NULL CHECK (max_transit_days > 0),
  status TEXT CHECK (status IN ('posted', 'in_transit', 'out_for_delivery', 'delivered', 'exception')),
  status_since TEXT,
  transit_started_at TEXT,
  delivered_at TEXT,
  registered_at TEXT NOT NULL,
  last_checked_at TEXT,
  UNIQUE (carrier, tracking_code)
);

-- fingerprint = id do evento no agregador ou hash do conteúdo; consultar de novo não duplica.
CREATE TABLE IF NOT EXISTS tracking_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  fingerprint TEXT NOT NULL,
  external_id TEXT,
  occurred_at TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  description TEXT,
  location TEXT,
  status TEXT NOT NULL CHECK (status IN ('posted', 'in_transit', 'out_for_delivery', 'delivered', 'exception')),
  recognized INTEGER NOT NULL CHECK (recognized IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('poll', 'webhook')),
  received_at TEXT NOT NULL,
  UNIQUE (shipment_id, fingerprint)
);

-- No máximo um alerta de atraso por envio.
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  type TEXT NOT NULL CHECK (type IN ('delayed')),
  created_at TEXT NOT NULL,
  detail TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  notified_at TEXT,
  UNIQUE (shipment_id, type)
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
