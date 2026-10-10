// Único arquivo que conhece o formato do agregador fictício:
//
//   POST /v2/trackers                    { code, courier }      → 201 (ou 409 se já existe)
//   GET  /v2/trackers/:courier/:code                            → 200 { data: { code, courier, checkpoints[] } }
//   webhook                              { event: "tracker.updated", data: { ...igual ao GET } }

import { ProviderError, type ProviderEvent, type ProviderTracking, type TrackingProvider } from "./types.ts";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpAggregatorClient implements TrackingProvider {
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetch?: FetchFn; timeoutMs?: number }) {}

  async register(code: string, carrier: string): Promise<void> {
    const res = await this.request("POST", "/v2/trackers", { code, courier: carrier });
    if (res.status === 201 || res.status === 409) return;
    throw this.failure(res);
  }

  async fetchTracking(code: string, carrier: string): Promise<ProviderTracking> {
    const res = await this.request("GET", `/v2/trackers/${encodeURIComponent(carrier)}/${encodeURIComponent(code)}`);
    if (res.status !== 200) throw this.failure(res);
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    return parseTracker(body?.data);
  }

  parseWebhook(body: unknown): ProviderTracking {
    const record = asRecord(body);
    if (record.event !== "tracker.updated")
      throw new ProviderError("webhook do agregador com evento inesperado", false);
    return parseTracker(record.data);
  }

  private async request(method: string, path: string, json?: unknown): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    try {
      return await doFetch(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          "x-api-key": this.options.apiKey,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw new ProviderError(
        `agregador indisponível: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  private failure(res: Response): ProviderError {
    const retryable = res.status === 429 || res.status >= 500;
    return new ProviderError(`agregador respondeu ${res.status}`, retryable, res.status);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("resposta do agregador em formato inesperado", false);
  }
  return value as Record<string, unknown>;
}

export function parseTracker(data: unknown): ProviderTracking {
  const tracker = asRecord(data);
  if (typeof tracker.code !== "string" || typeof tracker.courier !== "string" || !Array.isArray(tracker.checkpoints)) {
    throw new ProviderError("tracker sem code, courier ou checkpoints", false);
  }
  // Um checkpoint malformado não derruba os outros: é descartado e contado.
  const events: ProviderEvent[] = [];
  let skipped = 0;
  for (const raw of tracker.checkpoints) {
    const cp = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const occurredAt = cp && typeof cp.time === "string" ? new Date(cp.time) : null;
    if (
      !cp ||
      !occurredAt ||
      Number.isNaN(occurredAt.getTime()) ||
      typeof cp.courier_status !== "string" ||
      cp.courier_status.trim() === ""
    ) {
      skipped += 1;
      continue;
    }
    const location = [cp.city, cp.state].filter((part) => typeof part === "string" && part !== "").join("/");
    events.push({
      externalId: typeof cp.checkpoint_id === "string" ? cp.checkpoint_id : null,
      occurredAt: occurredAt.toISOString(),
      rawStatus: cp.courier_status,
      description: typeof cp.message === "string" ? cp.message : null,
      location: location || null,
    });
  }
  return { code: tracker.code, carrier: tracker.courier, events, skipped };
}
