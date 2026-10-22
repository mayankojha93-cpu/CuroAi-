import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
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
    final_disposition: z.string().min(1),
    identity_confirmed: z.boolean().nullable().optional(),
    pickup_accepted: z.boolean().nullable().optional(),
    proposed_date: z.string().nullable().optional(),
    confirmed_date: z.string().nullable().optional(),
    registered_address_confirmed: z.boolean().nullable().optional(),
    new_address: z.string().nullable().optional(),
    alternate_phone: z.string().nullable().optional(),
    customer_note: z.string().nullable().optional(),
    escalation_required: z.boolean().nullable().optional(),
    transcript_reference: z.string().nullable().optional(),
    transcript: z.any().optional(),
    duration_seconds: z.number().nullable().optional(),
    median_latency_ms: z.number().nullable().optional(),
    cost_estimate_inr: z.number().nullable().optional(),
    recording_url: z.string().nullable().optional(),
  }),
};

const inboundSchema = {
  body: z.object({
    roomName: z.string().min(1),
    phone: z.string().optional().default(''),
    sipCallId: z.string().optional().default(''),
  }),
};

// Constant-time secret comparison
const requireInternalSecret = (req: Request, _res: Response, next: NextFunction) => {
  const secretHeader = req.get('X-Internal-Secret') || '';
  const a = Buffer.from(secretHeader);
  const b = Buffer.from(env.INTERNAL_SECRET || '');
  if (!env.INTERNAL_SECRET || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
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
      const outcome = await callService.saveOutcome(req.params.callId, req.body);
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

// GET /internal/customers/lookup - Lookup customer record by incoming phone number
internalRouter.get(
  '/internal/customers/lookup',
  requireInternalSecret,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const phone = req.query.phone as string;
      if (!phone) {
        return res.status(400).json({ error: 'phone query parameter is required' });
      }
      const customer = await callService.lookupCustomerByPhone(phone);
      return res.status(200).json({ found: !!customer, customer });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /internal/calls/inbound - Register (idempotent per room) inbound SIP call and return customer details
internalRouter.post(
  '/internal/calls/inbound',
  requireInternalSecret,
  validateRequest(inboundSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { roomName, phone, sipCallId } = req.body;
      const result = await callService.registerInboundCall({ roomName, phone, sipCallId });
      return res.status(201).json({
        success: true,
        call: result.call,
        customer: result.customer,
      });
    } catch (err) {
      return next(err);
    }
  }
);
