// DEV-145: idempotency keys on every payment write. Keys live for 24 hours.
const TTL_MS = 24 * 60 * 60 * 1000;
const seen = new Map<string, { at: number; result: unknown }>();

/** Key = order + attempt group. The same order always maps to the same key, so retries can't double-charge. */
export function keyFor(orderId: string, operation: 'charge' | 'refund' | 'capture'): string {
  return `${operation}:${orderId}`;
  // TODO(DEV-145): partial captures need a per-capture suffix (open item from the 21 Oct entry).
  // TODO(DEV-145): decide whether a key may be reused across payment methods.
}

export function remember(key: string, result: unknown) {
  seen.set(key, { at: Date.now(), result });
}

export function recall<T>(key: string): T | undefined {
  const hit = seen.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    seen.delete(key);
    return undefined;
  }
  return hit.result as T;
}
