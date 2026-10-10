import { describe, expect, it } from "vitest";
import { evaluateDelay } from "../src/delay.ts";
import { normalizeStatus } from "../src/normalize.ts";
import { deriveStatus } from "../src/status.ts";

describe("normalização dos dialetos", () => {
  it("traduz o código de cada transportadora para o conjunto estável", () => {
    expect(normalizeStatus("alfalog", "04")).toEqual({ status: "out_for_delivery", recognized: true });
    expect(normalizeStatus("betaexpress", "ENTREGUE")).toEqual({ status: "delivered", recognized: true });
    expect(normalizeStatus("gamaentregas", "picked_up")).toEqual({ status: "posted", recognized: true });
  });

  it("status que a transportadora inventou vira exceção, nunca entregue", () => {
    expect(normalizeStatus("betaexpress", "ENTREGUE_NO_COFRE_INTELIGENTE")).toEqual({
      status: "exception",
      recognized: false,
    });
    expect(normalizeStatus("alfalog", "05X")).toEqual({ status: "exception", recognized: false });
  });

  it("o mesmo texto não vale entre transportadoras diferentes", () => {
    expect(normalizeStatus("alfalog", "delivered")).toEqual({ status: "exception", recognized: false });
  });
});

describe("status atual", () => {
  const at = (iso: string) => new Date(iso).toISOString();

  it("segue o evento que aconteceu por último, não o último que chegou", () => {
    const arrivalOrder = [
      { occurredAt: at("2026-03-02T16:10:00Z"), status: "posted" as const },
      { occurredAt: at("2026-03-05T12:00:00Z"), status: "out_for_delivery" as const },
      { occurredAt: at("2026-03-03T09:00:00Z"), status: "in_transit" as const }, // antigo, chegou depois
    ];
    expect(deriveStatus(arrivalOrder)).toEqual({ status: "out_for_delivery", since: at("2026-03-05T12:00:00Z") });
  });

  it("aceita volta legítima no tempo: saiu para entrega, ausente, em trânsito de novo", () => {
    const events = [
      { occurredAt: at("2026-03-05T12:00:00Z"), status: "out_for_delivery" as const },
      { occurredAt: at("2026-03-05T18:00:00Z"), status: "exception" as const },
      { occurredAt: at("2026-03-06T08:00:00Z"), status: "in_transit" as const },
    ];
    expect(deriveStatus(events).status).toBe("in_transit");
  });

  it("entregue é final, mesmo com evento posterior", () => {
    const events = [
      { occurredAt: at("2026-03-06T10:00:00Z"), status: "delivered" as const },
      { occurredAt: at("2026-03-06T11:00:00Z"), status: "in_transit" as const },
    ];
    expect(deriveStatus(events)).toEqual({ status: "delivered", since: at("2026-03-06T10:00:00Z") });
  });

  it("sem eventos, não há status", () => {
    expect(deriveStatus([])).toEqual({ status: null, since: null });
  });
});

describe("regra de atraso (datas controladas)", () => {
  const start = "2026-03-02T16:10:00.000Z"; // limite de 7 dias → prazo em 2026-03-09T16:10:00.000Z

  it("não está atrasado no instante exato do limite", () => {
    const result = evaluateDelay({
      transitStartedAt: start,
      deliveredAt: null,
      now: new Date("2026-03-09T16:10:00.000Z"),
      limitDays: 7,
    });
    expect(result).toMatchObject({ delayed: false, deadline_at: "2026-03-09T16:10:00.000Z", elapsed_hours: 168 });
  });

  it("está atrasado 1 ms depois do limite, se ainda não foi entregue", () => {
    const result = evaluateDelay({
      transitStartedAt: start,
      deliveredAt: null,
      now: new Date("2026-03-09T16:10:00.001Z"),
      limitDays: 7,
    });
    expect(result.delayed).toBe(true);
  });

  it("entrega dentro do prazo não vira atraso, mesmo consultada semanas depois", () => {
    const result = evaluateDelay({
      transitStartedAt: start,
      deliveredAt: "2026-03-06T10:00:00.000Z",
      now: new Date("2026-04-30T00:00:00.000Z"),
      limitDays: 7,
    });
    expect(result).toMatchObject({ delayed: false, measured_until: "2026-03-06T10:00:00.000Z" });
  });

  it("entrega depois do limite fica marcada como atrasada", () => {
    const result = evaluateDelay({
      transitStartedAt: start,
      deliveredAt: "2026-03-10T09:00:00.000Z",
      now: new Date("2026-03-10T09:00:00.000Z"),
      limitDays: 7,
    });
    expect(result.delayed).toBe(true);
  });

  it("sem nenhum evento, o trânsito não começou e não há atraso", () => {
    const result = evaluateDelay({
      transitStartedAt: null,
      deliveredAt: null,
      now: new Date("2026-12-31T00:00:00.000Z"),
      limitDays: 7,
    });
    expect(result).toMatchObject({ delayed: false, transit_started_at: null });
  });
});
