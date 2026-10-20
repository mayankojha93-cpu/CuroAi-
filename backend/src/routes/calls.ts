import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { callService } from '../services/callService.js';
import { validateRequest } from '../middleware/validate.js';

export const callsRouter = Router();

const initiateCallSchema = {
  body: z.object({
    customerId: z.string().uuid({ message: 'customerId must be a valid UUID' }),
  }),
};

const getCallSchema = {
  params: z.object({
    id: z.string().uuid({ message: 'Call ID must be a valid UUID' }),
  }),
};

// POST /calls - Initiate call to customer
callsRouter.post(
  '/calls',
  validateRequest(initiateCallSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { customerId } = req.body;
      const call = await callService.initiateCall(customerId);
      return res.status(201).json({
        message: 'Call initiated successfully',
        call: {
          id: call.id,
          customerId: call.customer_id,
          status: call.status,
          roomName: call.room_name,
          createdAt: call.created_at,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /calls/:id - Get specific call outcome and details
callsRouter.get(
  '/calls/:id',
  validateRequest(getCallSchema),
  async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const call = await callService.getCall(req.params.id);
      return res.json({ call });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /calls - Get latest 20 calls
callsRouter.get('/calls', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const calls = await callService.listRecentCalls(20);
    return res.json({ calls, count: calls.length });
  } catch (err) {
    return next(err);
  }
});
