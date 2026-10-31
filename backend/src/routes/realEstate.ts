import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { realEstateCallService } from '../services/realEstateCallService.js';
import { validateRequest } from '../middleware/validate.js';
import { AppError } from '../middleware/errorHandler.js';

export const realEstateRouter = Router();

// Constant-time internal secret check
const requireInternalSecret = (req: Request, _res: Response, next: NextFunction) => {
  const secretHeader = req.get('X-Internal-Secret') || '';
  const a = Buffer.from(secretHeader);
  const b = Buffer.from(env.INTERNAL_SECRET || '');
  if (!env.INTERNAL_SECRET || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new AppError('Unauthorized: Invalid or missing X-Internal-Secret header', 401));
  }
  next();
};

// Enforce pipeline permission: Real Estate admin or superadmin ('all') only
realEstateRouter.use('/api/real-estate', (req: Request, res: Response, next: NextFunction) => {
  const userPipeline = req.user?.assigned_pipeline;
  if (userPipeline && userPipeline !== 'all' && userPipeline !== 'real_estate') {
    return res.status(403).json({
      error: 'Forbidden: Your account does not have access to the Real Estate (My Estate Finder) pipeline.',
    });
  }
  next();
});

const testCallSchema = {
  body: z.object({
    phone: z.string().min(8, { message: 'Valid phone number is required' }),
    name: z.string().optional(),
    owner_name: z.string().optional(),
    language: z.string().optional().default('en'),
    notes: z.string().optional(),
  }),
};

const initiateCallSchema = {
  body: z.object({
    leadId: z.string().uuid({ message: 'leadId must be a valid UUID' }),
  }),
};

// 1. POST /api/real-estate/calls/test
realEstateRouter.post(
  '/api/real-estate/calls/test',
  validateRequest(testCallSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await realEstateCallService.initiateTestCall(req.body);
      return res.status(201).json({
        success: true,
        message: `My Estate Finder test call initiated to ${result.lead.phone}`,
        call: result.call,
        lead: result.lead,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// 2. POST /api/real-estate/calls/initiate
realEstateRouter.post(
  '/api/real-estate/calls/initiate',
  validateRequest(initiateCallSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const call = await realEstateCallService.initiateCall(req.body.leadId);
      return res.status(201).json({
        success: true,
        message: 'Real estate outreach call placed successfully',
        call,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// 3. GET /api/real-estate/leads
realEstateRouter.get('/api/real-estate/leads', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const leads = await realEstateCallService.getLeads({ status, limit, offset });
    return res.status(200).json({ success: true, count: leads.length, leads });
  } catch (err) {
    return next(err);
  }
});

// 4. GET /api/real-estate/properties
realEstateRouter.get('/api/real-estate/properties', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = req.query.category as string | undefined;
    const intent = req.query.intent as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const properties = await realEstateCallService.getProperties({ category, intent, limit });
    return res.status(200).json({ success: true, count: properties.length, properties });
  } catch (err) {
    return next(err);
  }
});

// 5. POST /internal/real-estate/calls/:callId/outcome
realEstateRouter.post(
  '/internal/real-estate/calls/:callId/outcome',
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      const outcome = await realEstateCallService.saveOutcome(req.params.callId, req.body);
      return res.status(200).json({
        success: true,
        message: 'Real estate call outcome and property details saved successfully',
        outcome,
      });
    } catch (err) {
      return next(err);
    }
  }
);

