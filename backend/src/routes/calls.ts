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

const importLeadsSchema = {
  body: z.object({
    leads: z.array(
      z.object({
        name: z.string().default('Customer'),
        phone: z.string().min(10, { message: 'Phone must be valid' }),
        address: z.string().min(3, { message: 'Address is required' }),
        language: z.string().optional().default('hi'),
        account_no: z.string().optional(),
        subs_del_no: z.string().optional(),
        service_end_date: z.string().optional(),
        r_date: z.string().optional(),
      })
    ).min(1, { message: 'Leads array cannot be empty' }),
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

// POST /api/leads/import - Bulk import leads from CSV/Excel
callsRouter.post(
  '/api/leads/import',
  validateRequest(importLeadsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { leads } = req.body;
      const imported = await callService.importLeads(leads);
      return res.status(201).json({
        success: true,
        message: `Successfully imported ${imported.length} leads`,
        count: imported.length,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/campaign/summary - Audit dashboard summary (Image 1)
callsRouter.get('/api/campaign/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await callService.getCampaignSummary();
    return res.json({ success: true, summary });
  } catch (err) {
    return next(err);
  }
});

// GET /api/retries/pending - View queue of customers awaiting retry
callsRouter.get('/api/retries/pending', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pending = await callService.getPendingRetries();
    return res.json({ success: true, count: pending.length, pending });
  } catch (err) {
    return next(err);
  }
});

// GET /api/customers - List all leads/customers
callsRouter.get('/api/customers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const customers = await callService.listCustomers(100);
    return res.json({ success: true, count: customers.length, customers });
  } catch (err) {
    return next(err);
  }
});

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
