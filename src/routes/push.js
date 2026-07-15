// Push subscription management.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';
import { getVapidPublicKey, saveSubscription, removeSubscription } from '../push.js';

export const pushRouter = Router();

pushRouter.get('/vapid-public-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key });
});

const subSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }).passthrough(),
});

pushRouter.post('/subscribe', authenticate, validate(subSchema), asyncHandler(async (req, res) => {
  await saveSubscription(req.auth.subjectId, req.valid.subscription);
  res.json({ ok: true });
}));

pushRouter.post('/unsubscribe', authenticate, validate(z.object({ endpoint: z.string().url() })), asyncHandler(async (req, res) => {
  await removeSubscription(req.valid.endpoint);
  res.json({ ok: true });
}));
