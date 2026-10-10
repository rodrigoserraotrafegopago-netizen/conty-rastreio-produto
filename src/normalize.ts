import type { Status } from "./status.ts";

// Dialeto de cada transportadora (fictícias) → status estável. O agregador só repassa esses códigos,
// então trocar de agregador não mexe aqui.

export const CARRIER_DIALECTS: Record<string, Record<string, Status>> = {
  // Códigos numéricos.
  alfalog: {
    "01": "posted",
    "02": "in_transit",
    "03": "in_transit",
    "04": "out_for_delivery",
    "05": "delivered",
    "91": "exception",
    "92": "exception",
    "93": "exception",
  },
  // Texto em maiúsculas.
  betaexpress: {
    COLETADO: "posted",
    EM_TRANSFERENCIA: "in_transit",
    EM_ROTA_DE_ENTREGA: "out_for_delivery",
    ENTREGUE: "delivered",
    TENTATIVA_FALHOU: "exception",
    DEVOLVIDO_AO_REMETENTE: "exception",
  },
  // Texto em inglês.
  gamaentregas: {
    picked_up: "posted",
    in_transit: "in_transit",
    arrived_at_hub: "in_transit",
    out_for_delivery: "out_for_delivery",
    delivered: "delivered",
    delivery_failed: "exception",
    returned_to_sender: "exception",
  },
};

export const SUPPORTED_CARRIERS = Object.keys(CARRIER_DIALECTS);

// Código fora da tabela vira "exception" (o texto original fica no histórico), nunca "delivered".
export function normalizeStatus(carrier: string, rawStatus: string): { status: Status; recognized: boolean } {
  const table = Object.hasOwn(CARRIER_DIALECTS, carrier) ? CARRIER_DIALECTS[carrier] : undefined;
  const key = rawStatus.trim();
  const status = table && Object.hasOwn(table, key) ? table[key] : undefined;
  return status ? { status, recognized: true } : { status: "exception", recognized: false };
}
