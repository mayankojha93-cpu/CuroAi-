import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { query } from '../db/index.js';
import { env } from '../config/env.js';
import { callService } from '../services/callService.js';
import { realEstateCallService } from '../services/realEstateCallService.js';
import { validateRequest } from '../middleware/validate.js';
import { parseCsvToLeads } from '../utils/csvParser.js';
import { processCallRecording } from '../services/recordingDownloader.js';

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
      const script = (req.body.script || '').toLowerCase();
      if (
        script.includes('my_estate') ||
        script.includes('estate_finder') ||
        script.includes('sagar') ||
        script.includes('property')
      ) {
        const { call, lead } = await realEstateCallService.initiateTestCall({
          phone: req.body.phone,
          owner_name: req.body.customer_name || req.body.name,
          language: req.body.language,
          notes: `Test Call: ${req.body.script || 'My Estate Finder'}`,
        });
        return res.status(201).json({
          success: true,
          message: `Test call placed successfully to ${lead.phone} via My Estate Finder Agent`,
          call: {
            id: call.id,
            customerId: lead.id,
            status: call.status,
            roomName: call.room_name,
            phone: lead.phone,
            customerName: lead.owner_name,
            companyName: (call as any).company_name || 'My Estate Finder',
            script: (call as any).script || 'My Estate Finder — Property Intake',
            voicePipeline: (call as any).voice_pipeline || 'Sarvam AI (Arvind - hi-IN)',
            language: lead.preferred_language || 'en',
            createdAt: call.created_at,
          },
          customer: lead,
        });
      }

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

// GET /api/calls/:id/audio - Stream seekable audio recording for playback
callsRouter.get('/api/calls/:id/audio', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id: callId } = req.params;
    const callRes = await query('SELECT id, recording_url, recording_download_status FROM calls WHERE id = $1', [callId]);
    if (callRes.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const storageDir = env.RECORDING_STORAGE_DIR || path.join(process.cwd(), 'recordings');
    const possibleFiles = [
      path.join(storageDir, `${callId}.mp3`),
      path.join(storageDir, `${callId}.wav`),
    ];

    let filePath: string | null = null;
    for (const f of possibleFiles) {
      if (fs.existsSync(f)) {
        filePath = f;
        break;
      }
    }

    if (!filePath) {
      const recUrl = callRes.rows[0].recording_url;
      // If already a remote CDN URL, redirect to it
      if (recUrl && (recUrl.startsWith('http://') || recUrl.startsWith('https://')) && !recUrl.includes('/api/calls/')) {
        return res.redirect(recUrl);
      }
      return res.status(404).json({
        error: 'Recording audio file is still being processed or unavailable',
        status: callRes.rows[0].recording_download_status || 'pending',
      });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // HTTP 206 Partial Content for seekable playback in browser audio players
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/mpeg',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    return next(err);
  }
});

// POST /api/exotel/recording-callback & /api/webhooks/exotel - Real-time webhook from Exotel
callsRouter.post(
  ['/api/exotel/recording-callback', '/api/webhooks/exotel'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        CallSid,
        RecordingUrl,
        RecordingDuration,
        To,
        From,
        CustomField,
      } = req.body || {};

      if (!RecordingUrl) {
        return res.status(400).json({ error: 'Missing RecordingUrl in Exotel webhook payload' });
      }

      const durSeconds = RecordingDuration ? parseInt(String(RecordingDuration), 10) : undefined;

      // 1. Match call by Exotel CallSid, custom call ID, or destination phone number
      let targetCallId: string | null = null;

      if (CallSid) {
        const sidMatch = await query('SELECT id FROM calls WHERE exotel_call_sid = $1 LIMIT 1', [CallSid]);
        if (sidMatch.rows.length > 0) targetCallId = sidMatch.rows[0].id;
      }

      if (!targetCallId && CustomField) {
        const customMatch = await query('SELECT id FROM calls WHERE id = $1 LIMIT 1', [CustomField]);
        if (customMatch.rows.length > 0) targetCallId = customMatch.rows[0].id;
      }

      if (!targetCallId && To) {
        const cleanTo = String(To).replace(/[^0-9+]/g, '');
        const phoneMatch = await query(
          `SELECT c.id FROM calls c
           LEFT JOIN customers cust ON c.customer_id = cust.id
           LEFT JOIN real_estate_leads rl ON c.re_lead_id = rl.id
           WHERE (cust.phone = $1 OR rl.phone = $1 OR cust.phone = $2 OR rl.phone = $2)
             AND c.created_at > NOW() - INTERVAL '2 hours'
           ORDER BY c.created_at DESC
           LIMIT 1`,
          [cleanTo, cleanTo.replace(/^\+91/, '')]
        );
        if (phoneMatch.rows.length > 0) targetCallId = phoneMatch.rows[0].id;
      }

      if (!targetCallId) {
        return res.status(404).json({ error: 'Could not correlate Exotel callback to an active call record' });
      }

      // 2. Download and save recording
      const streamUrl = await processCallRecording(targetCallId, RecordingUrl, CallSid, durSeconds);

      return res.status(200).json({
        success: true,
        message: 'Exotel recording saved and associated with call',
        callId: targetCallId,
        streamUrl,
      });
    } catch (err) {
      return next(err);
    }
  }
);



