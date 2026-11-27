import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logisticsCallService } from '../services/logisticsCallService.js';
import { validateRequest } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';

export const logisticsRouter = Router();

// Enforce strict pipeline permission: ONLY Logistics admin ('logistics') can access
logisticsRouter.use('/api/logistics', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  const userPipeline = req.user?.assigned_pipeline;
  if (userPipeline !== 'logistics') {
    return res.status(403).json({
      error: 'Forbidden: Only authorized Mittal Pigments Logistics accounts can access this dashboard.',
    });
  }
  next();
});

const tripSchema = z.object({
  driver_name: z.string().min(1, 'Driver name is required'),
  driver_phone: z.string().min(8, 'Valid driver phone is required'),
  vehicle_number: z.string().min(4, 'Vehicle number is required'),
  lr_number: z.string().min(1, 'LR number is required'),
  origin: z.string().optional(),
  destination: z.string().optional(),
  consignee: z.string().optional(),
  material: z.string().optional(),
  expected_unload_date: z.string().optional(),
  current_call_round: z.number().int().min(1).max(2).optional().default(1),
  next_assignment: z.string().optional(),
  plant_contact_number: z.string().optional(),
  ops_number: z.string().optional(),
  notes: z.string().optional(),
  tts_provider: z.string().optional(),
});

const initiateCallSchema = {
  body: z.object({
    tripId: z.string().uuid({ message: 'tripId must be a valid UUID' }),
    callRound: z.number().int().min(1).max(2).optional(),
    tts_provider: z.string().optional(),
  }),
};

// GET /api/logistics/summary
logisticsRouter.get('/api/logistics/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await logisticsCallService.getSummary();
    return res.json({ success: true, summary });
  } catch (err) {
    return next(err);
  }
});

// GET /api/logistics/trips
logisticsRouter.get('/api/logistics/trips', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const trips = await logisticsCallService.getTrips({ status, limit, offset });
    return res.json({ success: true, count: trips.length, trips });
  } catch (err) {
    return next(err);
  }
});

// POST /api/logistics/trips
logisticsRouter.post(
  '/api/logistics/trips',
  validateRequest({ body: tripSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await logisticsCallService.createTrip(req.body);
      return res.status(201).json({ success: true, trip });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/logistics/trips/import
logisticsRouter.post(
  '/api/logistics/trips/import',
  validateRequest({ body: z.object({ trips: z.array(tripSchema).min(1) }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trips = await logisticsCallService.importTrips(req.body.trips);
      return res.status(201).json({ success: true, count: trips.length, trips });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/logistics/calls/test
logisticsRouter.post(
  '/api/logistics/calls/test',
  validateRequest({ body: tripSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await logisticsCallService.initiateTestCall(req.body);
      return res.status(201).json({
        success: true,
        message: `Mittal Pigments Logistics call initiated to ${result.trip.driver_phone}`,
        call: result.call,
        trip: result.trip,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/logistics/calls/initiate
logisticsRouter.post(
  '/api/logistics/calls/initiate',
  validateRequest(initiateCallSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await logisticsCallService.initiateCall(
        req.body.tripId,
        req.body.callRound,
        false,
        req.body.tts_provider
      );
      return res.status(201).json({
        success: true,
        message: 'Logistics driver call placed successfully',
        call: result.call,
        trip: result.trip,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/logistics/calls
logisticsRouter.get('/api/logistics/calls', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const calls = await logisticsCallService.getCalls(limit, offset);
    return res.json({ success: true, count: calls.length, calls });
  } catch (err) {
    return next(err);
  }
});

// GET /api/logistics/escalations
logisticsRouter.get('/api/logistics/escalations', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const escalations = await logisticsCallService.getEscalations();
    return res.json({ success: true, count: escalations.length, escalations });
  } catch (err) {
    return next(err);
  }
});
