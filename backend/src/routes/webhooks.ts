import { Router, Request, Response, NextFunction } from 'express';
import { callService } from '../services/callService.js';
import { logger } from '../config/logger.js';

export const webhooksRouter = Router();

// POST /webhooks/livekit - Receives and verifies LiveKit server webhooks
webhooksRouter.post(
  '/webhooks/livekit',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.get('Authorization');
      const rawBody = (req as any).rawBody || req.body;

      if (!rawBody) {
        return res.status(400).send('Missing webhook payload');
      }

      const result = await callService.processLiveKitWebhook(rawBody, authHeader);
      return res.status(200).json({ status: 'ok', result });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to verify or process LiveKit webhook');
      return res.status(400).send(`Webhook verification error: ${err.message}`);
    }
  }
);
