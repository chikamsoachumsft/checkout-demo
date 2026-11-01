// DEV-147: gateway webhooks, deduplicated by event id so a replay can't mark an order paid twice.
const processed = new Set<string>();
const paidOrders = new Set<string>();

export interface GatewayEvent {
  id: string;
  type: 'charge.succeeded' | 'charge.refunded';
  orderId: string;
}

export function handleWebhook(event: GatewayEvent): 'processed' | 'duplicate' {
  if (processed.has(event.id)) return 'duplicate';
  processed.add(event.id);
  if (event.type === 'charge.succeeded') paidOrders.add(event.orderId);
  if (event.type === 'charge.refunded') paidOrders.delete(event.orderId);
  return 'processed';
}

export const isPaid = (orderId: string) => paidOrders.has(orderId);

// TODO(DEV-147): backfill check over the last 30 days of webhook events.
// TODO(DEV-153): emit a metric when duplicates are rejected, for retry alerting.
