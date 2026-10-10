// Tempo em trânsito: do primeiro evento da transportadora até a entrega, no horário em que os eventos
// aconteceram. Entregue, mede até a entrega (não até agora), por isso uma entrega no prazo nunca vira
// atraso, mesmo consultada semanas depois. Sem eventos, o trânsito não começou.

const DAY_MS = 24 * 60 * 60 * 1000;

export type DelayEvaluation = {
  limit_days: number;
  transit_started_at: string | null;
  deadline_at: string | null;
  measured_until: string | null;
  elapsed_hours: number | null;
  delayed: boolean;
};

export function evaluateDelay(input: {
  transitStartedAt: string | null;
  deliveredAt: string | null;
  now: Date;
  limitDays: number;
}): DelayEvaluation {
  if (!input.transitStartedAt) {
    return {
      limit_days: input.limitDays,
      transit_started_at: null,
      deadline_at: null,
      measured_until: null,
      elapsed_hours: null,
      delayed: false,
    };
  }
  const start = new Date(input.transitStartedAt).getTime();
  const deadline = start + input.limitDays * DAY_MS;
  const end = input.deliveredAt ? new Date(input.deliveredAt).getTime() : input.now.getTime();
  return {
    limit_days: input.limitDays,
    transit_started_at: new Date(start).toISOString(),
    deadline_at: new Date(deadline).toISOString(),
    measured_until: new Date(end).toISOString(),
    elapsed_hours: Math.round(((end - start) / 3_600_000) * 10) / 10,
    delayed: end > deadline,
  };
}
