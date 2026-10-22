import express, { Router, Request, Response } from 'express';
import { callService } from '../services/callService.js';
import { logger } from '../config/logger.js';

export const webhooksRouter = Router();

/**
 * POST /webhooks/livekit
 *
 * LiveKit signs the EXACT raw bytes of the body (content-type: application/webhook+json).
 * The old handler used `req.rawBody || req.body`: with express.json() mounted globally, `req.body`
 * is `{}` for this content-type, so the signature check always failed ("[object Object]").
 * express.raw() here guarantees we receive the untouched Buffer.
 *
 * IMPORTANT: mount this router BEFORE any global `app.use(express.json())`, e.g.
 *   app.use(webhooksRouter);
 *   app.use(express.json());
 */
webhooksRouter.post(
  '/webhooks/livekit',
  express.raw({ type: () => true, limit: '2mb' }),
  async (req: Request, res: Response) => {
    const authHeader = req.get('Authorization');
    const rawBody: Buffer | string | undefined =
      (req as any).rawBody ||
      (Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? req.body : undefined);

    if (!rawBody || (Buffer.isBuffer(rawBody) && rawBody.length === 0)) {
      logger.error(
        'LiveKit webhook has no raw body. Mount webhooksRouter before express.json() (or capture rawBody).'
      );
      return res.status(400).send('Missing webhook payload');
    }

    try {
      const result = await callService.processLiveKitWebhook(rawBody, authHeader);
      return res.status(200).json({ status: 'ok', result });
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Failed to verify or process LiveKit webhook');
      return res.status(400).send(`Webhook verification error: ${err?.message}`);
    }
  }
);
