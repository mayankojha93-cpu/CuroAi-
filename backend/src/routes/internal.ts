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
    outcome: z.string().optional(),
    final_disposition: z.string(),
    identity_confirmed: z.boolean().nullable().optional(),
    pickup_accepted: z.boolean().nullable().optional(),
    proposed_date: z.string().nullable().optional(),
    confirmed_date: z.string().nullable().optional(),
    registered_address_confirmed: z.boolean().nullable().optional(),
    new_address: z.string().nullable().optional(),
    alternate_phone: z.string().nullable().optional(),
    customer_note: z.string().nullable().optional(),
    escalation_required: z.boolean().optional(),
    transcript_reference: z.string().nullable().optional(),
    transcript: z.any().optional(),
    duration_seconds: z.number().nullable().optional(),
    median_latency_ms: z.number().nullable().optional(),
    cost_estimate_inr: z.number().nullable().optional(),
    recording_url: z.string().nullable().optional(),
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
