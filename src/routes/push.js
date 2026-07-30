// Push subscription management.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';
import { getVapidPublicKey, saveSubscription, removeSubscription } from '../push.js';

export const pushRouter = Router();

/**
 * @swagger
 * /push/vapid-public-key:
 *   get:
 *     summary: Get VAPID public key for push subscriptions
 *     tags: [Push]
 *     responses:
 *       200:
 *         description: VAPID public key for web push
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 key: { type: string, description: 'Base64-encoded VAPID public key' }
 *       503:
 *         description: Push notifications not configured

 * /push/subscribe:
 *   post:
 *     summary: Subscribe to push notifications
 *     tags: [Push]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subscription]
 *             properties:
 *               subscription:
 *                 type: object
 *                 required: [endpoint, keys]
 *                 properties:
 *                   endpoint: { type: string, format: uri }
 *                   keys:
 *                     type: object
 *                     properties:
 *                       p256dh: { type: string }
 *                       auth: { type: string }
 *     responses:
 *       200:
 *         description: Subscription registered

 * /push/unsubscribe:
 *   post:
 *     summary: Unsubscribe from push notifications
 *     tags: [Push]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [endpoint]
 *             properties:
 *               endpoint: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Subscription removed
 */

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
