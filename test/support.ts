import type { ProviderError, ProviderEvent, ProviderTracking, TrackingProvider } from "../src/aggregator/types.ts";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { Alert, Notifier } from "../src/shipments.ts";

/**
 * Outra implementação de TrackingProvider, com formato próprio e sem HTTP.
 * Os testes do serviço usam esta, e não o cliente HTTP: o resto do código não depende do agregador.
 */
export class InMemoryProvider implements TrackingProvider {
  readonly registered: string[] = [];
  private readonly events = new Map<string, ProviderEvent[]>();
  failNext: ProviderError | null = null;

  async register(code: string, carrier: string): Promise<void> {
    this.registered.push(`${carrier}/${code}`);
  }

  async fetchTracking(code: string, carrier: string): Promise<ProviderTracking> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    return { code, carrier, events: [...(this.events.get(`${carrier}/${code}`) ?? [])] };
  }

  parseWebhook(body: unknown): ProviderTracking {
    return body as ProviderTracking;
  }

  /** A transportadora registra eventos (a ordem aqui é a ordem em que o agregador devolve). */
  push(carrier: string, code: string, ...events: ProviderEvent[]) {
    const key = `${carrier}/${code}`;
    this.events.set(key, [...(this.events.get(key) ?? []), ...events]);
  }
}

export function event(
  externalId: string | null,
  occurredAt: string,
  rawStatus: string,
  description?: string,
): ProviderEvent {
  return {
    externalId,
    occurredAt: new Date(occurredAt).toISOString(),
    rawStatus,
    description: description ?? null,
    location: "São Paulo/SP",
  };
}

export function setup(options: { startAt?: string; defaultMaxTransitDays?: number; failNotifications?: number } = {}) {
  let current = new Date(options.startAt ?? "2026-03-02T12:00:00.000Z");
  const db = openDatabase(":memory:");
  const provider = new InMemoryProvider();
  const notified: Alert[] = [];
  let failuresLeft = options.failNotifications ?? 0;
  const notifier: Notifier = {
    notify: (alert) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("canal de aviso fora do ar");
      }
      notified.push(alert);
    },
  };
  const app = createApp({
    db,
    provider,
    notifier,
    clock: { now: () => new Date(current) },
    defaultMaxTransitDays: options.defaultMaxTransitDays ?? 7,
  });
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    app,
    db,
    provider,
    notified,
    post,
    get: (path: string) => app.request(path),
    setNow(iso: string) {
      current = new Date(iso);
    },
  };
}

export type ShipmentView = {
  id: string;
  status: string | null;
  status_label: string;
  status_since: string | null;
  delivered_at: string | null;
  delay: {
    delayed: boolean;
    deadline_at: string | null;
    elapsed_hours: number | null;
    transit_started_at: string | null;
  };
  alerts: Alert[];
  events: Array<{ occurred_at: string; status: string; recognized: boolean; raw_status: string; source: string }>;
};

export async function json<T = ShipmentView>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
