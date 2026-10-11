import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ProviderError, type ProviderTracking, type TrackingProvider } from "./aggregator/types.ts";
import type { Clock } from "./clock.ts";
import { evaluateDelay } from "./delay.ts";
import { DomainError } from "./errors.ts";
import { parseInstant } from "./instant.ts";
import { normalizeStatus, SUPPORTED_CARRIERS } from "./normalize.ts";
import { deriveStatus, STATUS_LABELS, type Status } from "./status.ts";

type ShipmentRow = {
  id: string;
  carrier: string;
  tracking_code: string;
  campaign_id: string | null;
  creator_id: string | null;
  max_transit_days: number;
  status: Status | null;
  status_since: string | null;
  transit_started_at: string | null;
  delivered_at: string | null;
  registered_at: string;
  last_checked_at: string | null;
};

type EventRow = {
  occurred_at: string;
  raw_status: string;
  description: string | null;
  location: string | null;
  status: Status;
  recognized: number;
  source: "poll" | "webhook";
  received_at: string;
};

type AlertRow = {
  id: string;
  shipment_id: string;
  type: "delayed";
  created_at: string;
  detail: string;
  resolved_at: string | null;
  resolution: string | null;
  notified_at: string | null;
};

export type Alert = {
  id: string;
  shipment_id: string;
  type: "delayed";
  created_at: string;
  detail: Record<string, unknown>;
  resolved_at: string | null;
  resolution: string | null;
  notified_at: string | null;
};

export type Notifier = { notify(alert: Alert & { carrier: string; tracking_code: string }): void };

export const consoleNotifier: Notifier = {
  notify: (alert) => console.log(JSON.stringify({ msg: "shipment.delayed", ...alert })),
};

export type Logger = { error(entry: Record<string, unknown>): void };

export const consoleLogger: Logger = { error: (entry) => console.error(JSON.stringify(entry)) };

const CODE_RE = /^[A-Za-z0-9-]{5,40}$/;

function fingerprint(event: {
  externalId: string | null;
  occurredAt: string;
  rawStatus: string;
  location: string | null;
  description: string | null;
}): string {
  if (event.externalId) return `id:${event.externalId}`;
  const content = [event.occurredAt, event.rawStatus, event.location ?? "", event.description ?? ""].join("|");
  return `sha1:${createHash("sha1").update(content).digest("hex")}`;
}

function toAlert(row: AlertRow): Alert {
  return { ...row, detail: JSON.parse(row.detail) as Record<string, unknown> };
}

export function createShipmentService({
  db,
  clock,
  provider,
  notifier = consoleNotifier,
  logger = consoleLogger,
  defaultMaxTransitDays = 7,
  newId = () => crypto.randomUUID(),
}: {
  db: DatabaseSync;
  clock: Clock;
  provider: TrackingProvider;
  notifier?: Notifier;
  logger?: Logger;
  defaultMaxTransitDays?: number;
  newId?: () => string;
}) {
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function load(id: string): ShipmentRow {
    const row = db.prepare("SELECT * FROM shipments WHERE id = ?").get(id) as ShipmentRow | undefined;
    if (!row) throw new DomainError("envio_nao_encontrado", "Envio não encontrado.", 404);
    return row;
  }

  function byCode(carrier: string, code: string): ShipmentRow | undefined {
    return db.prepare("SELECT * FROM shipments WHERE carrier = ? AND tracking_code = ?").get(carrier, code) as
      | ShipmentRow
      | undefined;
  }

  function delayOf(row: ShipmentRow) {
    return evaluateDelay({
      transitStartedAt: row.transit_started_at,
      deliveredAt: row.delivered_at,
      now: clock.now(),
      limitDays: row.max_transit_days,
    });
  }

  function view(id: string) {
    const row = load(id);
    const events = db
      .prepare(
        `SELECT occurred_at, raw_status, description, location, status, recognized, source, received_at
           FROM tracking_events WHERE shipment_id = ? ORDER BY occurred_at, seq`,
      )
      .all(id) as EventRow[];
    const alerts = db.prepare("SELECT * FROM alerts WHERE shipment_id = ? ORDER BY created_at").all(id) as AlertRow[];
    return {
      id: row.id,
      carrier: row.carrier,
      tracking_code: row.tracking_code,
      campaign_id: row.campaign_id,
      creator_id: row.creator_id,
      status: row.status,
      status_label: row.status ? STATUS_LABELS[row.status] : "aguardando o primeiro evento",
      status_since: row.status_since,
      delivered_at: row.delivered_at,
      delay: delayOf(row),
      alerts: alerts.map(toAlert),
      events: events.map((e) => ({
        occurred_at: e.occurred_at,
        status: e.status,
        status_label: STATUS_LABELS[e.status],
        recognized: e.recognized === 1,
        raw_status: e.raw_status,
        description: e.description,
        location: e.location,
        source: e.source,
        received_at: e.received_at,
      })),
      registered_at: row.registered_at,
      last_checked_at: row.last_checked_at,
    };
  }

  // Um alerta por envio (índice único). Entregue com atraso e sem alerta anterior: cria já resolvido.
  function reviewDelay(shipmentId: string): Alert | null {
    const row = load(shipmentId);
    const delay = delayOf(row);
    const now = clock.now().toISOString();
    let createdId: string | null = null;

    if (delay.delayed) {
      const id = newId();
      const detail = {
        status: row.status,
        transit_started_at: delay.transit_started_at,
        deadline_at: delay.deadline_at,
        elapsed_hours: delay.elapsed_hours,
        limit_days: row.max_transit_days,
      };
      const inserted = db
        .prepare(
          "INSERT OR IGNORE INTO alerts (id, shipment_id, type, created_at, detail) VALUES (?, ?, 'delayed', ?, ?)",
        )
        .run(id, shipmentId, now, JSON.stringify(detail));
      if (Number(inserted.changes) === 1) createdId = id;
    }

    if (row.status === "delivered") {
      const resolution = delay.delayed
        ? `entregue com atraso, em ${delay.elapsed_hours} h (limite de ${row.max_transit_days} dias)`
        : `entregue dentro do prazo, em ${delay.elapsed_hours} h; o evento de entrega chegou depois do alerta`;
      db.prepare(
        "UPDATE alerts SET resolved_at = ?, resolution = ? WHERE shipment_id = ? AND type = 'delayed' AND resolved_at IS NULL",
      ).run(now, resolution, shipmentId);
    }

    return createdId ? toAlert(db.prepare("SELECT * FROM alerts WHERE id = ?").get(createdId) as AlertRow) : null;
  }

  // Se o aviso falhar, notified_at fica nulo e o próximo job reenvia.
  function announce(alert: Alert | null) {
    if (!alert) return;
    const row = load(alert.shipment_id);
    try {
      notifier.notify({ ...alert, carrier: row.carrier, tracking_code: row.tracking_code });
      db.prepare("UPDATE alerts SET notified_at = ? WHERE id = ?").run(clock.now().toISOString(), alert.id);
    } catch (error) {
      logger.error({ msg: "alert.notify_failed", alert_id: alert.id, error: String(error) });
    }
  }

  async function fetchFromProvider(shipment: ShipmentRow): Promise<ProviderTracking> {
    try {
      return await provider.fetchTracking(shipment.tracking_code, shipment.carrier);
    } catch (error) {
      throw asUpstreamError(error);
    }
  }

  function merge(shipment: ShipmentRow, tracking: ProviderTracking, source: "poll" | "webhook") {
    const now = clock.now().toISOString();
    let skipped = tracking.skipped ?? 0;
    const { newEvents, alert } = transaction(() => {
      let newEvents = 0;
      const insert = db.prepare(
        `INSERT OR IGNORE INTO tracking_events
           (shipment_id, fingerprint, external_id, occurred_at, raw_status, description, location, status, recognized, source, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of tracking.events) {
        // Comparamos strings ISO, então tudo vai para UTC antes. Horário sem fuso não dá para comparar: fica de fora.
        const occurred = parseInstant(event.occurredAt);
        if (!occurred) {
          skipped += 1;
          continue;
        }
        const occurredAt = occurred.toISOString();
        const normalized = normalizeStatus(shipment.carrier, event.rawStatus);
        const result = insert.run(
          shipment.id,
          fingerprint({ ...event, occurredAt }),
          event.externalId,
          occurredAt,
          event.rawStatus,
          event.description,
          event.location,
          normalized.status,
          normalized.recognized ? 1 : 0,
          source,
          now,
        );
        newEvents += Number(result.changes);
      }

      const all = db
        .prepare("SELECT occurred_at, status FROM tracking_events WHERE shipment_id = ?")
        .all(shipment.id) as Array<{ occurred_at: string; status: Status }>;
      const current = deriveStatus(all.map((e) => ({ occurredAt: e.occurred_at, status: e.status })));
      const transitStartedAt = all.reduce<string | null>(
        (min, e) => (min === null || e.occurred_at < min ? e.occurred_at : min),
        null,
      );
      db.prepare(
        `UPDATE shipments
            SET status = ?, status_since = ?, transit_started_at = ?, delivered_at = ?, last_checked_at = ?
          WHERE id = ?`,
      ).run(
        current.status,
        current.since,
        transitStartedAt,
        current.status === "delivered" ? current.since : null,
        now,
        shipment.id,
      );
      return { newEvents, alert: reviewDelay(shipment.id) };
    });
    announce(alert);
    return { new_events: newEvents, skipped_events: skipped, alert_created: alert, shipment: view(shipment.id) };
  }

  return {
    get: view,

    async register(input: unknown) {
      const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const carrier = typeof body.carrier === "string" ? body.carrier.trim().toLowerCase() : "";
      const code = typeof body.tracking_code === "string" ? body.tracking_code.trim().toUpperCase() : "";
      if (!SUPPORTED_CARRIERS.includes(carrier)) {
        throw new DomainError(
          "transportadora_invalida",
          `carrier precisa ser um de: ${SUPPORTED_CARRIERS.join(", ")}.`,
          422,
        );
      }
      if (!CODE_RE.test(code)) throw new DomainError("codigo_invalido", "tracking_code inválido.", 422);
      const maxDays = body.max_transit_days ?? defaultMaxTransitDays;
      if (typeof maxDays !== "number" || !Number.isInteger(maxDays) || maxDays < 1 || maxDays > 90) {
        throw new DomainError("limite_invalido", "max_transit_days precisa ser um inteiro entre 1 e 90.", 422);
      }

      // Cadastrar de novo também cadastra de novo no agregador (lá, código repetido não é erro). Se o
      // agregador perdeu o código, ou uma tentativa anterior caiu no meio, repetir o POST conserta.
      try {
        await provider.register(code, carrier);
      } catch (error) {
        throw asUpstreamError(error);
      }
      // Um INSERT só, que não faz nada se o código já existe: cadastros repetidos ou simultâneos (inclusive de
      // processos diferentes) terminam no mesmo envio.
      const inserted = db
        .prepare(
          `INSERT INTO shipments (id, carrier, tracking_code, campaign_id, creator_id, max_transit_days, registered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (carrier, tracking_code) DO NOTHING`,
        )
        .run(
          newId(),
          carrier,
          code,
          typeof body.campaign_id === "string" ? body.campaign_id : null,
          typeof body.creator_id === "string" ? body.creator_id : null,
          maxDays,
          clock.now().toISOString(),
        );
      const shipment = byCode(carrier, code) as ShipmentRow;
      return { created: Number(inserted.changes) === 1, shipment: view(shipment.id) };
    },

    async refresh(id: string) {
      const tracking = await fetchFromProvider(load(id));
      return merge(load(id), tracking, "poll");
    },

    ingestWebhook(body: unknown) {
      let tracking: ProviderTracking;
      try {
        tracking = provider.parseWebhook(body);
      } catch (error) {
        if (error instanceof ProviderError) throw new DomainError("webhook_invalido", error.message, 422);
        throw error;
      }
      const shipment = byCode(tracking.carrier.toLowerCase(), tracking.code.toUpperCase());
      if (!shipment) throw new DomainError("envio_nao_encontrado", "Código não cadastrado.", 404);
      return merge(shipment, tracking, "webhook");
    },

    // Antes de avisar, consulta o agregador: o evento de entrega pode só não ter chegado.
    // Com o agregador fora do ar, avisa com o que já sabe.
    async checkDelays() {
      const pending = db
        .prepare("SELECT id FROM shipments WHERE status IS NULL OR status <> 'delivered'")
        .all() as Array<{ id: string }>;
      const created: Alert[] = [];
      for (const { id } of pending) {
        const row = load(id);
        const hasAlert = db.prepare("SELECT 1 FROM alerts WHERE shipment_id = ? AND type = 'delayed'").get(id);
        if (hasAlert || !delayOf(row).delayed) continue;

        let alert: Alert | null;
        try {
          alert = merge(row, await provider.fetchTracking(row.tracking_code, row.carrier), "poll").alert_created;
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          alert = transaction(() => reviewDelay(id));
          announce(alert);
        }
        if (alert) created.push(alert);
      }

      const unsent = db
        .prepare("SELECT * FROM alerts WHERE notified_at IS NULL ORDER BY created_at")
        .all() as AlertRow[];
      for (const row of unsent) {
        if (!created.some((a) => a.id === row.id)) announce(toAlert(row));
      }
      return {
        checked: pending.length,
        alerts_created: created.map((a) =>
          toAlert(db.prepare("SELECT * FROM alerts WHERE id = ?").get(a.id) as AlertRow),
        ),
      };
    },

    listAlerts(onlyOpen: boolean) {
      const rows = db
        .prepare(`SELECT * FROM alerts ${onlyOpen ? "WHERE resolved_at IS NULL" : ""} ORDER BY created_at`)
        .all() as AlertRow[];
      return rows.map(toAlert);
    },
  };
}

function asUpstreamError(error: unknown): DomainError {
  if (error instanceof ProviderError) {
    return new DomainError("agregador_falhou", error.message, 502, {
      retryable: error.retryable,
      upstream_status: error.upstreamStatus ?? null,
    });
  }
  throw error;
}
