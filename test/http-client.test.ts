import { describe, expect, it } from "vitest";
import { createFakeAggregator } from "../src/aggregator/fake-server.ts";
import { HttpAggregatorClient, parseTracker } from "../src/aggregator/http-client.ts";
import { ProviderError } from "../src/aggregator/types.ts";

// Payload bruto do agregador fictício, como vem no GET e no webhook.
const RAW_TRACKER = {
  tracker_id: "trk_1",
  code: "AL123456789BR",
  courier: "alfalog",
  checkpoints: [
    {
      checkpoint_id: "cp_3",
      time: "2026-03-05T09:00:00-03:00",
      courier_status: "04",
      message: "Saiu para entrega",
      city: "Rio de Janeiro",
      state: "RJ",
    },
    {
      checkpoint_id: "cp_1",
      time: "2026-03-02T13:10:00-03:00",
      courier_status: "01",
      message: "Objeto postado",
      city: "São Paulo",
      state: "SP",
    },
    {
      checkpoint_id: "cp_2",
      time: "2026-03-03T08:45:00-03:00",
      courier_status: "02",
      message: "Em transferência",
      city: "Cajamar",
      state: "SP",
    },
  ],
};

function clientAgainstFake(apiKey = "k-test") {
  const fake = createFakeAggregator({ apiKey: "k-test" });
  const client = new HttpAggregatorClient({
    baseUrl: "http://agregador.test",
    apiKey,
    fetch: (url, init) => Promise.resolve(fake.app.request(url, init)),
  });
  return { fake, client };
}

describe("cliente HTTP do agregador", () => {
  it("traduz o payload bruto para o formato interno", () => {
    const tracking = parseTracker(RAW_TRACKER);
    expect(tracking.code).toBe("AL123456789BR");
    expect(tracking.carrier).toBe("alfalog");
    expect(tracking.events[1]).toEqual({
      externalId: "cp_1",
      occurredAt: "2026-03-02T16:10:00.000Z",
      rawStatus: "01",
      description: "Objeto postado",
      location: "São Paulo/SP",
    });
  });

  it("cadastra o código, aceita cadastro repetido e consulta os eventos por HTTP", async () => {
    const { fake, client } = clientAgainstFake();
    await client.register("AL123456789BR", "alfalog");
    await client.register("AL123456789BR", "alfalog"); // 409 no agregador: já cadastrado, não é erro
    fake.trackers.get("alfalog/AL123456789BR")?.checkpoints.push(...RAW_TRACKER.checkpoints);

    const tracking = await client.fetchTracking("AL123456789BR", "alfalog");
    expect(tracking.events.map((e) => e.externalId)).toEqual(["cp_3", "cp_1", "cp_2"]);
  });

  it("descarta checkpoint malformado sem perder os válidos", () => {
    const tracking = parseTracker({
      ...RAW_TRACKER,
      checkpoints: [
        ...RAW_TRACKER.checkpoints,
        { checkpoint_id: "cp_bad", time: "ontem", courier_status: "02" },
        "lixo",
      ],
    });
    expect(tracking.events).toHaveLength(3);
    expect(tracking.skipped).toBe(2);
  });

  it("traduz o webhook do agregador", () => {
    const { client } = clientAgainstFake();
    const tracking = client.parseWebhook({ event: "tracker.updated", data: RAW_TRACKER });
    expect(tracking.events).toHaveLength(3);
    expect(() => client.parseWebhook({ event: "outra.coisa", data: RAW_TRACKER })).toThrow(ProviderError);
  });

  it("separa falha definitiva de falha que vale tentar de novo", async () => {
    const wrongKey = clientAgainstFake("chave-errada").client;
    await expect(wrongKey.fetchTracking("AL123456789BR", "alfalog")).rejects.toMatchObject({
      retryable: false,
      upstreamStatus: 401,
    });

    const unavailable = new HttpAggregatorClient({
      baseUrl: "http://agregador.test",
      apiKey: "k",
      fetch: async () => new Response("erro", { status: 503 }),
    });
    await expect(unavailable.fetchTracking("X1234", "alfalog")).rejects.toMatchObject({
      retryable: true,
      upstreamStatus: 503,
    });

    const offline = new HttpAggregatorClient({
      baseUrl: "http://agregador.test",
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(offline.register("X1234", "alfalog")).rejects.toMatchObject({ retryable: true });
  });
});
