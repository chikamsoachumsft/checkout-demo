// Charge a card through the gateway with an idempotency key (DEV-145).
import { gatewayCharge, type ChargeResult } from './gateway-mock.js';
import { keyFor, recall, remember } from './idempotency.js';

export async function charge(orderId: string, amountCents: number): Promise<ChargeResult> {
  const key = keyFor(orderId, 'charge');
  const cached = recall<ChargeResult>(key);
  if (cached) return cached;
  const result = await gatewayCharge(orderId, amountCents, key);
  remember(key, result);
  return result;
}

// TODO(DEV-145): refund() and capture() still call the gateway without a key.
