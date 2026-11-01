import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charge } from '../../src/checkout/charge.js';
import { handleWebhook } from '../../src/checkout/webhook-handler.js';

test('the same order is charged once, even if submitted twice', async () => {
  const [a, b] = await Promise.all([charge('order-1', 4200), charge('order-1', 4200)]);
  assert.equal(a.chargeId, b.chargeId);
});

test('a replayed webhook is ignored', () => {
  const ev = { id: 'evt_1', type: 'charge.succeeded' as const, orderId: 'order-2' };
  assert.equal(handleWebhook(ev), 'processed');
  assert.equal(handleWebhook(ev), 'duplicate');
});

// TODO(DEV-145): partial captures are not covered yet.
