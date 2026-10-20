import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { callService } from '../services/callService.js';
import { validateRequest } from '../middleware/validate.js';
import { AppError } from '../middleware/errorHandler.js';

export const internalRouter = Router();

const outcomeSchema = {
  params: z.object({
    callId: z.string().uuid({ message: 'callId must be a valid UUID' }),
  }),
  body: z.object({
    outcome: z.enum([
      'pickup_scheduled',
      'pickup_declined',
      'wrong_person',
      'callback_requested',
      'escalated',
      'no_response',
    ]),
    pickup_date: z.string().nullable().optional(),
    address_confirmed: z.boolean().nullable().optional(),
    corrected_address: z.string().nullable().optional(),
    transcript: z.any().optional(),
  }),
};

// Internal secret auth middleware
const requireInternalSecret = (req: Request, _res: Response, next: NextFunction) => {
  const secretHeader = req.get('X-Internal-Secret');
  if (!secretHeader || secretHeader !== env.INTERNAL_SECRET) {
    return next(new AppError('Unauthorized: Invalid or missing X-Internal-Secret header', 401));
  }
  next();
};

// POST /internal/calls/:callId/outcome - Idempotent outcome save
internalRouter.post(
  '/internal/calls/:callId/outcome',
  requireInternalSecret,
  validateRequest(outcomeSchema),
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      const { callId } = req.params;
      const outcome = await callService.saveOutcome(callId, req.body);
      return res.status(200).json({
        success: true,
        message: 'Call outcome saved successfully',
        outcome,
      });
    } catch (err) {
      return next(err);
    }
  }
);
