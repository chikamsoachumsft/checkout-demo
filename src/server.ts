// Checkout service (fictional sample). Run: npm install && npm start → http://localhost:5060
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chargeWithRetry } from './checkout/retry-worker.js';
import { handleWebhook, isPaid, type GatewayEvent } from './checkout/webhook-handler.js';

const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

app.post('/api/checkout/pay', async (req, res) => {
  const { orderId, amountCents } = req.body ?? {};
  if (!orderId || !Number.isInteger(amountCents)) return res.status(400).json({ error: 'orderId and integer amountCents required' });
  try {
    res.json(await chargeWithRetry(String(orderId), amountCents));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.post('/api/webhooks/gateway', (req, res) => {
  res.json({ result: handleWebhook(req.body as GatewayEvent) });
});

app.get('/api/orders/:id', (req, res) => res.json({ orderId: req.params.id, paid: isPaid(req.params.id) }));

const port = Number(process.env.PORT ?? 5060);
app.listen(port, () => console.log(`Checkout running at http://localhost:${port}`));
