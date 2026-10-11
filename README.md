# Rastreio do produto enviado ao criador

[![ci](https://github.com/rodrigoserraotrafegopago-netizen/conty-rastreio-produto/actions/workflows/ci.yml/badge.svg)](https://github.com/rodrigoserraotrafegopago-netizen/conty-rastreio-produto/actions/workflows/ci.yml)

Acompanha o pacote que a marca manda para o criador. A API cadastra o código num agregador de rastreio (fictício), consulta e recebe eventos, traduz o dialeto de cada transportadora para cinco status estáveis e avisa quando o tempo em trânsito passa do limite.

Node 22.13+ · TypeScript · Hono · SQLite (`node:sqlite`) · Vitest

```bash
npm install
npm test            # 40 testes
npm run dev         # http://127.0.0.1:3007
```

Sem `AGGREGATOR_URL`, o `npm run dev` sobe junto um agregador fictício em `/_fake-aggregator`, e o cliente HTTP fala com ele por HTTP de verdade. Outras variáveis estão em `.env.example` (o `.env` é lido se existir). `npm run lint` e `npm run typecheck` também rodam no CI.

## Status

`posted` (postado), `in_transit` (em trânsito), `out_for_delivery` (saiu para entrega), `delivered` (entregue) e `exception` (exceção). Antes do primeiro evento, `status` é `null`.

- **Dialetos:** uma tabela por transportadora em `src/normalize.ts`. Para o exemplo, criei três transportadoras fictícias, cada uma com um dialeto: `alfalog` (códigos numéricos), `betaexpress` (texto em maiúsculas) e `gamaentregas` (inglês).
- **Status desconhecido:** vira `exception`, com `recognized: false` e o texto original guardado. Nunca vira `delivered` por palpite.
- **Fora de ordem:** o status atual é o do evento que aconteceu por último (no horário da transportadora), não o do último que chegou (`src/status.ts`). Um evento antigo que chega atrasado entra no histórico sem mudar o status. Um retrocesso real, com horários crescentes (saiu para entrega → destinatário ausente → em trânsito), é seguido.
- **Entregue é final.** Todos os horários são convertidos para UTC antes de comparar.
- **Repetidos:** cada evento tem uma impressão digital (id do agregador ou hash do conteúdo) com índice único. Consultar de novo, ou receber o mesmo webhook, não duplica o histórico.

## Atraso

A regra está em `src/delay.ts`:

- O trânsito começa no primeiro evento da transportadora e termina na entrega, sempre no horário em que os eventos aconteceram.
- Não entregue: atrasado quando `agora − início > limite`.
- Entregue: atrasado só se `entrega − início > limite`. É isso que impede marcar entrega normal como atraso: o cálculo para na entrega, então uma entrega no prazo continua no prazo mesmo consultada semanas depois, ou com o evento de entrega chegando tarde.
- Sem eventos, o trânsito não começou e não há o que medir.
- O limite é `max_transit_days` por envio (padrão em `DEFAULT_MAX_TRANSIT_DAYS`), em dias corridos. No instante exato do limite ainda não está atrasado; 1 ms depois, está.

O aviso:

- Cada consulta ou webhook reavalia o envio, e `POST /jobs/check-delays` roda de tempos em tempos (o `npm run dev` agenda pela `DELAY_CHECK_INTERVAL_MINUTES`).
- Antes de avisar, o job consulta o agregador de novo, porque o evento de entrega pode só não ter chegado.
- Há no máximo um alerta por envio. Se o aviso falhar, o próximo job reenvia.
- Quando chega a entrega, o alerta é resolvido com o motivo ("entregue dentro do prazo; o evento de entrega chegou depois do alerta" ou "entregue com atraso").

## Trocar de agregador

`TrackingProvider` (`src/aggregator/types.ts`) define `register`, `fetchTracking` e `parseWebhook`, todos devolvendo eventos no formato interno. O formato do agregador fictício (`trackers`, `checkpoints`, `courier_status`, header `X-Api-Key`) só aparece em `src/aggregator/http-client.ts`. Isso vale também para os nomes: o agregador chama a transportadora pelo slug dele (`alfa-log`, `beta-express`, `gama-entregas`), e o adaptador traduz para o nome interno (`alfalog` etc.) nos dois sentidos. Transportadora que o agregador manda e não está na tabela é recusada. Os testes do serviço usam outra implementação, em memória e sem HTTP (`test/support.ts`).

Um checkpoint malformado, ou com horário sem fuso (sem fuso não dá para saber o instante), é descartado e contado (`skipped_events`), sem perder os válidos. O serviço aplica a mesma regra a qualquer `TrackingProvider`, não só ao cliente HTTP. Falha do agregador vira `502` com `retryable`: `429`, `5xx` e rede caída valem nova tentativa; `401` e `404`, não.

## Endpoints

| Método | Rota | |
| --- | --- | --- |
| `POST` | `/shipments` | `{ carrier, tracking_code, max_transit_days?, campaign_id?, creator_id? }`: `201` novo, `200` se já existia |
| `GET` | `/shipments/:id` | status, atraso, alertas e histórico (normalizado e bruto) |
| `POST` | `/shipments/:id/refresh` | consulta o agregador e junta o que for novo |
| `POST` | `/webhooks/aggregator` | eventos empurrados pelo agregador |
| `POST` | `/jobs/check-delays` | reavalia o atraso dos envios não entregues |
| `GET` | `/alerts?open=true` | alertas |

O `POST /shipments` só responde `2xx` com o código cadastrado no agregador. Repetir o POST é seguro: cadastra de novo lá (código repetido não é erro no agregador) e devolve o envio que já existe. Isso conserta o caso em que o agregador perdeu o código, como o fictício perde ao reiniciar o servidor.

## Exemplo: payload bruto → status normalizado

O agregador devolve os checkpoints fora de ordem, um deles repetido:

```json
{
  "data": {
    "tracker_id": "trk_1",
    "code": "AL123456789BR",
    "courier": "alfa-log",
    "checkpoints": [
      { "checkpoint_id": "cp_3", "time": "2026-10-08T09:00:00-03:00", "courier_status": "04", "message": "Saiu para entrega", "city": "Rio de Janeiro", "state": "RJ" },
      { "checkpoint_id": "cp_1", "time": "2026-10-06T13:10:00-03:00", "courier_status": "01", "message": "Objeto postado", "city": "São Paulo", "state": "SP" },
      { "checkpoint_id": "cp_1", "time": "2026-10-06T13:10:00-03:00", "courier_status": "01", "message": "Objeto postado", "city": "São Paulo", "state": "SP" }
    ]
  }
}
```

`POST /shipments/:id/refresh` (resposta real, cortada):

```json
{
  "new_events": 2,
  "shipment": {
    "status": "out_for_delivery",
    "status_label": "saiu para entrega",
    "status_since": "2026-10-08T12:00:00.000Z",
    "delay": {
      "limit_days": 7,
      "transit_started_at": "2026-10-06T16:10:00.000Z",
      "deadline_at": "2026-10-13T16:10:00.000Z",
      "elapsed_hours": 78.9,
      "delayed": false
    },
    "events": [
      { "occurred_at": "2026-10-06T16:10:00.000Z", "status": "posted", "recognized": true, "raw_status": "01", "location": "São Paulo/SP", "source": "poll" },
      { "occurred_at": "2026-10-08T12:00:00.000Z", "status": "out_for_delivery", "recognized": true, "raw_status": "04", "location": "Rio de Janeiro/RJ", "source": "poll" }
    ],
    "…": "…"
  }
}
```

Depois, chegam por webhook um evento antigo (`02`, de 07/10) e um status inventado (`77`):

```bash
curl -s -X POST localhost:3007/webhooks/aggregator -H 'content-type: application/json' -d '{
  "event": "tracker.updated",
  "data": { "code": "AL123456789BR", "courier": "alfa-log", "checkpoints": [
    { "checkpoint_id": "cp_2", "time": "2026-10-07T08:45:00-03:00", "courier_status": "02", "message": "Em transferência" },
    { "checkpoint_id": "cp_x", "time": "2026-10-07T10:00:00-03:00", "courier_status": "77", "message": "Pacote em análise especial" }
  ] }
}'
```

Os dois entram no histórico, e o status continua `out_for_delivery`:

```json
{
  "new_events": 2,
  "shipment": {
    "status": "out_for_delivery",
    "events": [
      { "occurred_at": "2026-10-06T16:10:00.000Z", "raw_status": "01", "status": "posted", "recognized": true, "source": "poll" },
      { "occurred_at": "2026-10-07T11:45:00.000Z", "raw_status": "02", "status": "in_transit", "recognized": true, "source": "webhook" },
      { "occurred_at": "2026-10-07T13:00:00.000Z", "raw_status": "77", "status": "exception", "recognized": false, "source": "webhook" },
      { "occurred_at": "2026-10-08T12:00:00.000Z", "raw_status": "04", "status": "out_for_delivery", "recognized": true, "source": "poll" }
    ],
    "…": "…"
  }
}
```

Para montar o cenário com o agregador fictício: cadastre o código em `POST /shipments`, mande os checkpoints um a um para `POST /_fake-aggregator/_demo/trackers/alfa-log/AL123456789BR/checkpoints` e chame `POST /shipments/:id/refresh`. O agregador fictício guarda tudo em memória: depois de reiniciar o servidor, repita o `POST /shipments` antes de mandar checkpoints.

## Testes

- `rules.test.ts`: dialetos, status inventado, evento fora de ordem, retrocesso real, entregue final e regra de atraso com datas controladas (no limite, 1 ms depois, entregue no prazo e consultado semanas depois, entregue atrasado, sem eventos).
- `shipments.test.ts`: cadastro idempotente (inclusive simultâneo e com o agregador fora do ar), consulta repetida sem duplicar, evento sem fuso descartado, webhook com evento antigo e repetido, alerta único, entrega normal sem alerta, alerta resolvido, job que confere o agregador antes de avisar, aviso reenviado depois de falhar, status `constructor`/`__proto__`, horário com offset, falha do agregador.
- `http-client.test.ts`: payload bruto → interno, slug da transportadora (conhecido e desconhecido), checkpoint malformado ou sem fuso, cadastro repetido (`409`) e consulta contra o agregador fictício, recadastro depois de o agregador perder o código, webhook, classificação de falhas.

## Decisões

- Desconhecido vira `exception` em vez de ser ignorado: aparece para a operação. Código novo recorrente entra na tabela da transportadora.
- Dias corridos. Dias úteis exigiriam calendário de feriados.
- O aviso é "pelo menos uma vez": se o canal aceitar e a gravação de `notified_at` falhar, o aviso pode repetir. Prefiro repetido a perdido.

## Com mais tempo

- Alerta de "sem movimentação há X dias" para envio cadastrado que nunca teve evento (código errado ou pacote não postado).
- Backoff com jitter e respeito ao limite de taxa do agregador.
- Assinatura no webhook do agregador e um `Notifier` de verdade (e-mail, Slack ou notificação no app da marca).

## Uso de IA

O código, os testes e esta documentação foram escritos com o Claude (Anthropic), a partir das minhas instruções. Acompanhei a sessão, defini o escopo e aprovei a publicação. Não revisei o código linha a linha.
