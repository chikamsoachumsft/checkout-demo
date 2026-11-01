// Fake payment gateway. Sometimes slow (that is what caused the October duplicate charges — DEV-138).
// Honors idempotency keys the way real gateways do: same key → same result, no second charge,
// including when two requests with the same key arrive at the same time.
export interface ChargeResult {
  chargeId: string;
  orderId: string;
  amountCents: number;
  status: 'succeeded' | 'failed';
}

const byKey = new Map<string, Promise<ChargeResult>>();
let counter = 0;

export function gatewayCharge(orderId: string, amountCents: number, idempotencyKey?: string): Promise<ChargeResult> {
  if (idempotencyKey && byKey.has(idempotencyKey)) return byKey.get(idempotencyKey)!;
  const slow = Math.random() < 0.2;
  const result = new Promise<ChargeResult>((resolve) =>
    setTimeout(() => resolve({ chargeId: `ch_${++counter}`, orderId, amountCents, status: 'succeeded' }), slow ? 4500 : 150),
  );
  if (idempotencyKey) byKey.set(idempotencyKey, result);
  return result;
}
