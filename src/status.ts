// Os cinco status que o resto do sistema conhece.

export const STATUSES = ["posted", "in_transit", "out_for_delivery", "delivered", "exception"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  posted: "postado",
  in_transit: "em trânsito",
  out_for_delivery: "saiu para entrega",
  delivered: "entregue",
  exception: "exceção",
};

// Só desempata eventos com o mesmo horário; não impede um retrocesso real
// (saiu para entrega → destinatário ausente → em trânsito de novo).
const TIE_BREAK: Record<Status, number> = {
  posted: 1,
  in_transit: 2,
  out_for_delivery: 3,
  exception: 4,
  delivered: 5,
};

export type NormalizedEvent = { occurredAt: string; status: Status };

// Status atual = o do evento que aconteceu por último, não o do último que chegou: evento antigo
// que chega atrasado não faz o status voltar. Entregue é final.
export function deriveStatus(events: NormalizedEvent[]): { status: Status | null; since: string | null } {
  const delivered = events
    .filter((e) => e.status === "delivered")
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0];
  if (delivered) return { status: "delivered", since: delivered.occurredAt };

  let latest: NormalizedEvent | undefined;
  for (const event of events) {
    if (
      !latest ||
      event.occurredAt > latest.occurredAt ||
      (event.occurredAt === latest.occurredAt && TIE_BREAK[event.status] > TIE_BREAK[latest.status])
    ) {
      latest = event;
    }
  }
  return latest ? { status: latest.status, since: latest.occurredAt } : { status: null, since: null };
}
