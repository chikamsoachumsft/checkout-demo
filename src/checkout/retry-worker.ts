// DEV-142: server-side payment retries. Safe because every attempt reuses the same idempotency key.
// Decision 16 Oct: NO client-side retries, NO queue-based retry (it redelivered under load — see project memory).
import { charge } from './charge.js';

export async function chargeWithRetry(orderId: string, amountCents: number, attempts = 3) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(charge(orderId, amountCents), 6000);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i)); // exponential backoff
    }
  }
  throw lastError;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('gateway timeout')), ms))]);
}
