import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { callService } from '../services/callService.js';
import { validateRequest } from '../middleware/validate.js';
import { parseCsvToLeads } from '../utils/csvParser.js';

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

const importLeadItemSchema = z.object({
  name: z.string().optional().default('Airtel Subscriber'),
  phone: z.string().optional(),
  address: z.string().optional().default('Address On Record'),
  language: z.string().optional().default('hi'),
  account_no: z.string().optional(),
  subs_del_no: z.string().optional(),
  service_end_date: z.string().optional(),
  r_date: z.string().optional(),
  check: z.string().optional(),
}).refine((data) => (data.phone && data.phone.trim().length > 0) || (data.subs_del_no && data.subs_del_no.trim().length > 0), {
  message: 'Either phone or subs_del_no must be provided to determine the dialable number',
  path: ['phone'],
});

const importLeadsSchema = {
  body: z.object({
    leads: z.array(importLeadItemSchema).optional(),
    csv: z.string().optional(),
  }).refine((data) => (data.leads && data.leads.length > 0) || (data.csv && data.csv.trim().length > 0), {
    message: 'Either leads array or csv string must be provided',
  }),
};

// POST /calls or /api/calls - Initiate call to customer
callsRouter.post(
  ['/calls', '/api/calls'],
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

const testCallSchema = {
  body: z.object({
    phone: z.string().min(5, { message: 'Phone or dialable number is required' }),
    name: z.string().optional().default('Test Subscriber'),
    customer_name: z.string().optional(),
    company_name: z.string().optional(),
    script: z.string().optional(),
    voice_pipeline: z.string().optional().default('HABot Pipeline'),
    address: z.string().optional().default('Delhi, 110011, burari, sant nagar'),
    account_no: z.string().optional().default('20022941256'),
    subs_del_no: z.string().optional().default('01121344121_wifi'),
    service_end_date: z.string().optional().default('2026-08-27'),
    r_date: z.string().optional().default('2026-08-29'),
    language: z.string().optional().default('en'),
  }),
};

// POST /api/calls/test - Place developer test call with sample presets
callsRouter.post(
  '/api/calls/test',
  validateRequest(testCallSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { call, customer } = await callService.initiateTestCall(req.body);
      return res.status(201).json({
        success: true,
        message: `Test call placed successfully to ${customer.phone}`,
        call: {
          id: call.id,
          customerId: customer.id,
          status: call.status,
          roomName: call.room_name,
          phone: customer.phone,
          customerName: customer.name,
          companyName: (call as any).company_name || req.body.company_name || null,
          script: (call as any).script || req.body.script || null,
          voicePipeline: (call as any).voice_pipeline || req.body.voice_pipeline || 'HABot Pipeline',
          language: customer.language || req.body.language || 'en',
          accountNo: customer.account_no,
          subsDelNo: customer.subs_del_no,
          serviceEndDate: customer.service_end_date,
          createdAt: call.created_at,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/leads/import - Bulk import leads from CSV/Excel JSON
callsRouter.post(
  '/api/leads/import',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let leadsToImport: any[] = [];

      // If raw text or string CSV was sent
      if (typeof req.body === 'string' && req.body.trim()) {
        leadsToImport = parseCsvToLeads(req.body);
      } else if (req.body?.csv && typeof req.body.csv === 'string') {
        leadsToImport = parseCsvToLeads(req.body.csv);
      } else if (Array.isArray(req.body?.leads)) {
        leadsToImport = req.body.leads;
      } else if (Array.isArray(req.body)) {
        leadsToImport = req.body;
      }

      if (leadsToImport.length === 0) {
        return res.status(400).json({
          error: 'No valid leads found in request payload. Provide a CSV file or leads array.',
        });
      }

      const imported = await callService.importLeads(leadsToImport);
      return res.status(201).json({
        success: true,
        message: `Successfully imported ${imported.length} leads into campaign`,
        count: imported.length,
        leads: imported,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/leads/upload-csv - Dedicated CSV text/file import endpoint
callsRouter.post(
  '/api/leads/upload-csv',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const csvContent = typeof req.body === 'string' ? req.body : req.body?.csv;
      if (!csvContent || typeof csvContent !== 'string' || !csvContent.trim()) {
        return res.status(400).json({ error: 'Missing CSV content in request body' });
      }

      const leads = parseCsvToLeads(csvContent);
      if (leads.length === 0) {
        return res.status(400).json({
          error: 'Could not parse any lead records from the provided CSV content. Ensure columns like SUBS_DEL_NO, ACCOUNT_NO, Address are present.',
        });
      }

      const imported = await callService.importLeads(leads);
      return res.status(201).json({
        success: true,
        message: `Successfully processed CSV and imported ${imported.length} leads`,
        count: imported.length,
        leads: imported,
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

// GET /calls/:id or /api/calls/:id - Get specific call outcome and details
callsRouter.get(
  ['/calls/:id', '/api/calls/:id'],
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

// GET /calls or /api/calls - Get latest calls across all campaigns with optional status filter
callsRouter.get(['/calls', '/api/calls'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const isTest = req.query.is_test === 'true';
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
    const calls = await callService.listRecentCalls(limit, status, isTest || undefined);
    return res.json({ calls, count: calls.length });
  } catch (err) {
    return next(err);
  }
});

// GET /api/calls/test-history - Get test call history with full transcripts and details
callsRouter.get('/api/calls/test-history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
    // Look up test calls first
    let calls = await callService.listRecentCalls(limit, status, true);
    // If no test-specific calls found, fall back to recent calls so user always has real data
    if (calls.length === 0) {
      calls = await callService.listRecentCalls(limit, status);
    }
    return res.json({ calls, count: calls.length });
  } catch (err) {
    return next(err);
  }
});
