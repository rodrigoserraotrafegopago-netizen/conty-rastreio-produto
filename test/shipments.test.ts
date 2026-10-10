import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/aggregator/types.ts";
import { event, json, setup } from "./support.ts";

const CODE = "AL123456789BR";
const posted = event("cp_1", "2026-03-02T13:10:00-03:00", "01", "Objeto postado"); // início do trânsito: 16:10Z
const transfer = event("cp_2", "2026-03-03T08:45:00-03:00", "02", "Em transferência");
const outForDelivery = event("cp_3", "2026-03-05T09:00:00-03:00", "04", "Saiu para entrega");

async function registered(t: ReturnType<typeof setup>, maxTransitDays?: number) {
  const res = await t.post("/shipments", { carrier: "alfalog", tracking_code: CODE, max_transit_days: maxTransitDays });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

describe("cadastro e consulta", () => {
  it("cadastra o código no agregador e começa sem status até o primeiro evento", async () => {
    const t = setup();
    const id = await registered(t);
    const shipment = await json(await t.get(`/shipments/${id}`));
    expect(shipment).toMatchObject({ status: null, status_label: "aguardando o primeiro evento", events: [] });
    expect(t.provider.registered).toEqual([`alfalog/${CODE}`]);
  });

  it("cadastrar o mesmo código de novo devolve o envio existente", async () => {
    const t = setup();
    const id = await registered(t);
    const again = await t.post("/shipments", { carrier: "alfalog", tracking_code: CODE.toLowerCase() });
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe(id);
    expect(t.provider.registered).toHaveLength(1);
  });

  it("consultar de novo o mesmo código não duplica o histórico", async () => {
    const t = setup();
    const id = await registered(t);
    t.provider.push("alfalog", CODE, posted, transfer);
    const first = await json<{ new_events: number; shipment: { events: unknown[] } }>(
      await t.post(`/shipments/${id}/refresh`),
    );
    const second = await json<{ new_events: number; shipment: { events: unknown[] } }>(
      await t.post(`/shipments/${id}/refresh`),
    );
    expect(first.new_events).toBe(2);
    expect(second.new_events).toBe(0);
    expect(second.shipment.events).toHaveLength(2);
  });

  it("evento sem id do agregador também não duplica (impressão digital pelo conteúdo)", async () => {
    const t = setup();
    const id = await registered(t);
    t.provider.push("alfalog", CODE, event(null, "2026-03-02T13:10:00-03:00", "01"));
    await t.post(`/shipments/${id}/refresh`);
    await t.post(`/shipments/${id}/refresh`);
    expect((await json(await t.get(`/shipments/${id}`))).events).toHaveLength(1);
  });

  it("falha do agregador responde 502 dizendo se vale tentar de novo", async () => {
    const t = setup();
    const id = await registered(t);
    t.provider.failNext = new ProviderError("agregador respondeu 503", true, 503);
    const res = await t.post(`/shipments/${id}/refresh`);
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ error: "agregador_falhou", retryable: true, upstream_status: 503 });
  });

  it("recusa transportadora que não conhecemos", async () => {
    const t = setup();
    const res = await t.post("/shipments", { carrier: "inventada", tracking_code: CODE });
    expect(res.status).toBe(422);
  });
});

describe("eventos repetidos e fora de ordem", () => {
  it("evento antigo que chega depois não faz o status voltar", async () => {
    const t = setup();
    const id = await registered(t);
    t.provider.push("alfalog", CODE, outForDelivery, posted); // o agregador devolve fora de ordem
    await t.post(`/shipments/${id}/refresh`);

    // Dias depois, chega por webhook um evento antigo (03/03) e um repetido.
    const res = await t.post("/webhooks/aggregator", {
      code: CODE,
      carrier: "alfalog",
      events: [transfer, outForDelivery],
    });
    const body = await json<{
      new_events: number;
      shipment: { status: string; status_since: string; events: unknown[] };
    }>(res);
    expect(body.new_events).toBe(1);
    expect(body.shipment.status).toBe("out_for_delivery");
    expect(body.shipment.status_since).toBe("2026-03-05T12:00:00.000Z");
    expect(body.shipment.events).toHaveLength(3);
  });

  it("status inventado pela transportadora vira exceção, não entregue, e o texto original fica no histórico", async () => {
    const t = setup();
    const id = await registered(t);
    t.provider.push(
      "alfalog",
      CODE,
      posted,
      event("cp_9", "2026-03-04T10:00:00-03:00", "77", "Entregue no cofre inteligente"),
    );
    const { shipment } = await json<{
      shipment: {
        status: string;
        delivered_at: string | null;
        events: Array<{ raw_status: string; status: string; recognized: boolean }>;
      };
    }>(await t.post(`/shipments/${id}/refresh`));
    expect(shipment.status).toBe("exception");
    expect(shipment.delivered_at).toBeNull();
    expect(shipment.events.at(-1)).toMatchObject({ raw_status: "77", status: "exception", recognized: false });
  });
});

describe("atraso (relógio controlado)", () => {
  it("avisa uma vez quando o tempo em trânsito passa do limite", async () => {
    const t = setup();
    const id = await registered(t, 7);
    t.provider.push("alfalog", CODE, posted, transfer);
    await t.post(`/shipments/${id}/refresh`);

    t.setNow("2026-03-09T16:10:00.000Z"); // exatamente 7 dias depois da postagem
    expect((await json<{ alerts_created: unknown[] }>(await t.post("/jobs/check-delays"))).alerts_created).toHaveLength(
      0,
    );

    t.setNow("2026-03-09T16:10:00.001Z");
    expect((await json<{ alerts_created: unknown[] }>(await t.post("/jobs/check-delays"))).alerts_created).toHaveLength(
      1,
    );
    t.setNow("2026-03-10T16:10:00.000Z");
    expect((await json<{ alerts_created: unknown[] }>(await t.post("/jobs/check-delays"))).alerts_created).toHaveLength(
      0,
    );

    expect(t.notified).toHaveLength(1);
    expect(t.notified[0]).toMatchObject({ type: "delayed", detail: { status: "in_transit", limit_days: 7 } });
    const shipment = await json(await t.get(`/shipments/${id}`));
    expect(shipment.delay.delayed).toBe(true);
    expect(shipment.alerts).toHaveLength(1);
  });

  it("entrega normal não vira atraso, mesmo consultada depois do limite", async () => {
    const t = setup();
    const id = await registered(t, 7);
    t.provider.push("alfalog", CODE, posted, transfer, event("cp_4", "2026-03-06T10:00:00-03:00", "05", "Entregue"));
    t.setNow("2026-04-20T12:00:00.000Z");
    const { shipment } = await json<{ shipment: { status: string; delay: { delayed: boolean } } }>(
      await t.post(`/shipments/${id}/refresh`),
    );
    expect(shipment.status).toBe("delivered");
    expect(shipment.delay.delayed).toBe(false);
    expect((await json<{ alerts_created: unknown[] }>(await t.post("/jobs/check-delays"))).alerts_created).toHaveLength(
      0,
    );
    expect(t.notified).toHaveLength(0);
  });

  it("quando a entrega aconteceu no prazo mas o evento chegou depois do alerta, o alerta é resolvido", async () => {
    const t = setup();
    const id = await registered(t, 7);
    t.provider.push("alfalog", CODE, posted);
    await t.post(`/shipments/${id}/refresh`);
    t.setNow("2026-03-10T12:00:00.000Z");
    await t.post("/jobs/check-delays");

    // O evento de entrega de 06/03 só aparece agora.
    t.provider.push("alfalog", CODE, event("cp_4", "2026-03-06T10:00:00-03:00", "05", "Entregue"));
    const { shipment } = await json<{
      shipment: {
        status: string;
        delay: { delayed: boolean };
        alerts: Array<{ resolved_at: string | null; resolution: string }>;
      };
    }>(await t.post(`/shipments/${id}/refresh`));
    expect(shipment.status).toBe("delivered");
    expect(shipment.delay.delayed).toBe(false);
    expect(shipment.alerts[0]?.resolved_at).toBe("2026-03-10T12:00:00.000Z");
    expect(shipment.alerts[0]?.resolution).toMatch(/^entregue dentro do prazo/);
  });

  it("sem nenhum evento, não avisa atraso (o trânsito não começou)", async () => {
    const t = setup();
    await registered(t, 7);
    t.setNow("2026-06-01T00:00:00.000Z");
    expect((await json<{ alerts_created: unknown[] }>(await t.post("/jobs/check-delays"))).alerts_created).toHaveLength(
      0,
    );
  });
});

describe("robustez", () => {
  it("o job consulta o agregador antes de avisar: entrega no prazo que ainda não tinha chegado não gera alerta", async () => {
    const t = setup();
    const id = await registered(t, 7);
    t.provider.push("alfalog", CODE, posted);
    await t.post(`/shipments/${id}/refresh`);
    t.provider.push("alfalog", CODE, event("cp_4", "2026-03-06T10:00:00-03:00", "05", "Entregue")); // ainda não consultado

    t.setNow("2026-03-12T12:00:00.000Z");
    const job = await json<{ alerts_created: unknown[] }>(await t.post("/jobs/check-delays"));
    expect(job.alerts_created).toHaveLength(0);
    expect(t.notified).toHaveLength(0);
    expect((await json(await t.get(`/shipments/${id}`))).status).toBe("delivered");
  });

  it("entregue com atraso, sem alerta anterior, gera o alerta uma vez e já resolvido", async () => {
    const t = setup();
    const id = await registered(t, 7);
    t.provider.push("alfalog", CODE, posted, event("cp_4", "2026-03-12T10:00:00-03:00", "05", "Entregue"));
    t.setNow("2026-03-12T15:00:00.000Z");
    const out = await json<{ alert_created: { resolved_at: string | null; resolution: string } | null }>(
      await t.post(`/shipments/${id}/refresh`),
    );
    expect(out.alert_created?.resolution).toMatch(/^entregue com atraso/);
    expect(t.notified).toHaveLength(1);
    await t.post(`/shipments/${id}/refresh`);
    expect(t.notified).toHaveLength(1);
  });

  it("aviso que falhou é reenviado no próximo job", async () => {
    const t = setup({ failNotifications: 1 });
    const id = await registered(t, 7);
    t.provider.push("alfalog", CODE, posted);
    await t.post(`/shipments/${id}/refresh`);
    t.setNow("2026-03-10T12:00:00.000Z");
    const first = await t.post("/jobs/check-delays");
    expect(first.status).toBe(200);
    expect(t.notified).toHaveLength(0);
    await t.post("/jobs/check-delays");
    expect(t.notified).toHaveLength(1);
    const shipment = await json(await t.get(`/shipments/${id}`));
    expect(shipment.alerts).toHaveLength(1);
    expect(shipment.alerts[0]?.notified_at).toBe("2026-03-10T12:00:00.000Z");
  });

  it("status com nome de propriedade do JavaScript não quebra a normalização", async () => {
    const t = setup();
    const id = await registered(t);
    t.provider.push(
      "alfalog",
      CODE,
      event("cp_a", "2026-03-02T13:10:00-03:00", "constructor"),
      event("cp_b", "2026-03-02T14:10:00-03:00", "__proto__"),
    );
    const res = await t.post(`/shipments/${id}/refresh`);
    expect(res.status).toBe(200);
    const body = await json<{ shipment: ShipmentLike }>(res);
    expect(body.shipment.events.map((e) => [e.status, e.recognized])).toEqual([
      ["exception", false],
      ["exception", false],
    ]);
  });

  it("horário com offset vindo de outro agregador é convertido para UTC antes de comparar", async () => {
    const t = setup();
    const id = await registered(t);
    // 09:00-03:00 (12:00Z) aconteceu depois de 11:00Z, apesar de "09" < "11" como texto.
    t.provider.push(
      "alfalog",
      CODE,
      { externalId: "x1", occurredAt: "2026-03-05T11:00:00Z", rawStatus: "02", description: null, location: null },
      { externalId: "x2", occurredAt: "2026-03-05T09:00:00-03:00", rawStatus: "04", description: null, location: null },
    );
    const body = await json<{ shipment: ShipmentLike }>(await t.post(`/shipments/${id}/refresh`));
    expect(body.shipment.status).toBe("out_for_delivery");
  });

  it("dois cadastros simultâneos do mesmo código não criam dois envios", async () => {
    const t = setup();
    const [a, b] = await Promise.all([
      t.post("/shipments", { carrier: "alfalog", tracking_code: CODE }),
      t.post("/shipments", { carrier: "alfalog", tracking_code: CODE }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await json(a)).id).toBe((await json(b)).id);
  });
});

type ShipmentLike = { status: string; events: Array<{ status: string; recognized: boolean }> };
