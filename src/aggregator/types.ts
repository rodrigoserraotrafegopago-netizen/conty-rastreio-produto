// Trocar de agregador = outra implementação de TrackingProvider. O resto do código só vê ProviderEvent.

export type ProviderEvent = {
  /** Id do evento no agregador, quando existe. */
  externalId: string | null;
  /** Quando aconteceu, no relógio da transportadora: ISO-8601 com fuso (`Z` ou `-03:00`). Sem fuso, é descartado. */
  occurredAt: string;
  /** Código da transportadora, do jeito que veio. */
  rawStatus: string;
  description: string | null;
  location: string | null;
};

export type ProviderTracking = {
  code: string;
  /** Nome interno da transportadora (`alfalog`), já traduzido do agregador. */
  carrier: string;
  events: ProviderEvent[];
  /** Eventos descartados por formato inválido. */
  skipped?: number;
};

export interface TrackingProvider {
  /** Cadastrar de novo o mesmo código não é erro. */
  register(code: string, carrier: string): Promise<void>;
  /** Pode trazer eventos repetidos e fora de ordem. */
  fetchTracking(code: string, carrier: string): Promise<ProviderTracking>;
  /** Traduz o webhook que o agregador empurra. */
  parseWebhook(body: unknown): ProviderTracking;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}
