import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from '../db/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { authService, UserPayload } from '../services/authService.js';
import { callService } from '../services/callService.js';
import { realEstateCallService } from '../services/realEstateCallService.js';
import { validateRequest } from '../middleware/validate.js';
import { parseCsvToLeads } from '../utils/csvParser.js';
import { processCallRecording, getRecordingsDir } from '../services/recordingDownloader.js';
import { s3Service } from '../services/s3Service.js';
import { fetchExotelCallDetails } from '../services/exotelService.js';

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

// POST /calls or /api/calls - Initiate call to customer (supports both Airtel & Real Estate pipelines)
callsRouter.post(
  ['/calls', '/api/calls'],
  validateRequest(initiateCallSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userPipeline = req.user?.assigned_pipeline;
      const { customerId } = req.body;

      // 1. Check if customerId is a real_estate_leads ID
      const reLead = await query('SELECT id, phone, owner_name, campaign_id FROM real_estate_leads WHERE id = $1', [customerId]);
      const isReLead = reLead.rows.length > 0;

      // 2. Strict pipeline isolation check
      if (userPipeline && userPipeline !== 'all') {
        if (userPipeline === 'real_estate' && !isReLead) {
          // Check if customerId is in customers table linked to a real_estate campaign
          const custCheck = await query(
            `SELECT c.id, camp.pipeline 
             FROM customers c 
             JOIN campaigns camp ON c.campaign_id = camp.id 
             WHERE c.id = $1`,
            [customerId]
          );
          if (custCheck.rows.length === 0 || custCheck.rows[0].pipeline !== 'real_estate') {
            return res.status(403).json({
              error: 'Forbidden: Your account (My Estate Finder) is not authorized to initiate Airtel telecom campaign calls.',
            });
          }
        } else if (userPipeline === 'airtel' && isReLead) {
          return res.status(403).json({
            error: 'Forbidden: Your account (Airtel Telecom) is not authorized to initiate Real Estate campaign calls.',
          });
        }
      }

      // 3. If real estate lead, initiate via realEstateCallService
      if (isReLead) {
        const call = await realEstateCallService.initiateCall(customerId);
        return res.status(201).json({
          message: 'Real estate campaign call initiated successfully',
          call: {
            id: call.id,
            customerId: call.re_lead_id,
            status: call.status,
            roomName: call.room_name,
            createdAt: call.created_at,
          },
        });
      }

      // 4. If customer belongs to a real estate campaign, bridge to real_estate_leads
      const custWithCamp = await query(
        `SELECT c.id, c.phone, c.name, c.campaign_id, camp.pipeline 
         FROM customers c 
         LEFT JOIN campaigns camp ON c.campaign_id = camp.id 
         WHERE c.id = $1`,
        [customerId]
      );
      if (custWithCamp.rows.length > 0 && custWithCamp.rows[0].pipeline === 'real_estate') {
        const custRow = custWithCamp.rows[0];
        let leadId: string;
        const existingLead = await query('SELECT id FROM real_estate_leads WHERE phone = $1', [custRow.phone]);
        if (existingLead.rows.length > 0) {
          leadId = existingLead.rows[0].id;
          if (!existingLead.rows[0].campaign_id && custRow.campaign_id) {
            await query('UPDATE real_estate_leads SET campaign_id = $1 WHERE id = $2', [custRow.campaign_id, leadId]);
          }
        } else {
          const newLead = await query(
            `INSERT INTO real_estate_leads (id, campaign_id, owner_name, phone, preferred_language, lead_status)
             VALUES (gen_random_uuid(), $1, $2, $3, 'en', 'NEW')
             RETURNING id`,
            [custRow.campaign_id, custRow.name, custRow.phone]
          );
          leadId = newLead.rows[0].id;
        }
        const call = await realEstateCallService.initiateCall(leadId);
        return res.status(201).json({
          message: 'Real estate campaign call initiated successfully',
          call: {
            id: call.id,
            customerId: call.re_lead_id,
            status: call.status,
            roomName: call.room_name,
            createdAt: call.created_at,
          },
        });
      }

      // 5. Default Airtel call initiation
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
    property_location: z.string().optional(),
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
      const userPipeline = req.user?.assigned_pipeline;
      const script = (req.body.script || '').toLowerCase();
      const company = (req.body.company_name || '').toLowerCase();
      const isRealEstateScript =
        userPipeline === 'real_estate' ||
        Boolean(req.body.property_location) ||
        script.includes('estate') ||
        script.includes('sagar') ||
        script.includes('property') ||
        company.includes('estate');

      // Strict multi-tenant isolation check
      if (userPipeline && userPipeline !== 'all') {
        if (userPipeline === 'airtel' && isRealEstateScript) {
          return res.status(403).json({
            error: 'Forbidden: Your account (Airtel Telecom) is not authorized to place Real Estate test calls.',
          });
        }
        if (userPipeline === 'real_estate' && !isRealEstateScript) {
          return res.status(403).json({
            error: 'Forbidden: Your account (My Estate Finder) is not authorized to place Airtel Telecom test calls.',
          });
        }
      }

      if (isRealEstateScript) {
        const rawLoc = (req.body.property_location || req.body.address || '').trim();
        const propertyLocation = (rawLoc && !['delhi, 110011, burari, sant nagar', 'none', 'null', 'undefined'].includes(rawLoc.toLowerCase()))
          ? rawLoc
          : undefined;
        const rawName = (req.body.customer_name || req.body.name || '').trim();
        const ownerName = (rawName && !['test subscriber', 'property owner', 'customer', 'none', 'null', 'undefined'].includes(rawName.toLowerCase())) ? rawName : undefined;

        const { call, lead } = await realEstateCallService.initiateTestCall({
          phone: req.body.phone,
          owner_name: ownerName,
          language: req.body.language,
          property_location: propertyLocation,
          address: propertyLocation,
          notes: `Test Call: ${req.body.script || 'My Estate Finder'}${propertyLocation ? ` | Location: ${propertyLocation}` : ''}`,
        });

        logger.info(
          { callId: call.id, phone: lead.phone, owner: lead.owner_name, location: propertyLocation, room: call.room_name },
          `📞 [TEST CALL INITIATED] ID: ${call.id} | Dialing: ${lead.phone} | Lead: ${lead.owner_name || 'Owner'} | Location: ${propertyLocation || 'Unspecified'}`
        );

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
            voicePipeline: (call as any).voice_pipeline || 'Sarvam AI (Priya - hi/en)',
            language: (call as any).language || lead.preferred_language || 'en',
            initialLanguage: (call as any).initial_language || lead.preferred_language || 'en',
            languageSwitched: (call as any).language_switched || false,
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
          language: (call as any).language || customer.language || 'hi',
          initialLanguage: (call as any).initial_language || customer.language || 'hi',
          languageSwitched: (call as any).language_switched || false,
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
      if (req.user?.assigned_pipeline && req.user.assigned_pipeline !== 'all' && req.user.assigned_pipeline !== 'airtel') {
        return res.status(403).json({
          error: 'Forbidden: Your account is not authorized to import Airtel telecom leads.',
        });
      }
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
      if (req.user?.assigned_pipeline && req.user.assigned_pipeline !== 'all' && req.user.assigned_pipeline !== 'airtel') {
        return res.status(403).json({
          error: 'Forbidden: Your account is not authorized to import Airtel telecom leads.',
        });
      }
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
callsRouter.get('/api/campaign/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await callService.getCampaignSummary(req.user?.assigned_pipeline);
    return res.json({ success: true, summary });
  } catch (err) {
    return next(err);
  }
});

// GET /api/retries/pending - View queue of customers awaiting retry
callsRouter.get('/api/retries/pending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pending = await callService.getPendingRetries(50, req.user?.assigned_pipeline);
    return res.json({ success: true, count: pending.length, pending });
  } catch (err) {
    return next(err);
  }
});

// GET /api/customers - List all leads/customers
callsRouter.get('/api/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customers = await callService.listCustomers(100, req.user?.assigned_pipeline);
    return res.json({ success: true, count: customers.length, customers });
  } catch (err) {
    return next(err);
  }
});

// GET /calls or /api/calls - Get latest calls across all campaigns with optional status filter
callsRouter.get(['/calls', '/api/calls'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const isTest = req.query.is_test === 'true';
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
    const calls = await callService.listRecentCalls(limit, status, isTest || undefined, req.user?.assigned_pipeline);
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
    const pipeline = req.user?.assigned_pipeline;
    // Look up test calls first
    let calls = await callService.listRecentCalls(limit, status, true, pipeline);
    // If no test-specific calls found, fall back to recent calls so user always has real data
    if (calls.length === 0) {
      calls = await callService.listRecentCalls(limit, status, undefined, pipeline);
    }
    return res.json({ calls, count: calls.length });
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
      const call = await callService.getCall(req.params.id, req.user?.assigned_pipeline);
      return res.json({ call });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/calls/:id/audio - Stream seekable audio recording or download from AWS S3 / local cache
callsRouter.get('/api/calls/:id/audio', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id: callId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) {
      return res.status(400).json({ error: 'Invalid call ID format' });
    }

    const callRes = await query('SELECT id, recording_url, recording_download_status, pipeline FROM calls WHERE id = $1', [callId]);
    if (callRes.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const call = callRes.rows[0];

    // Pipeline isolation check for audio recordings
    let requestingUser = req.user;
    if (!requestingUser) {
      const authHeader = req.headers.authorization;
      const token = (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null) || (req.query.token as string);
      if (token) {
        try {
          const decoded = jwt.verify(token, env.JWT_SECRET) as UserPayload;
          const u = await authService.getUserById(decoded.id);
          if (u) requestingUser = u;
        } catch {}
      }
    }

    if (!requestingUser) {
      return res.status(401).json({ error: 'Authentication required to access recordings' });
    }

    if (requestingUser.assigned_pipeline && requestingUser.assigned_pipeline !== 'all') {
      const callPipeline = call.pipeline || 'airtel';
      if (callPipeline !== requestingUser.assigned_pipeline) {
        return res.status(403).json({ error: 'Access forbidden: You cannot access audio recordings from another pipeline' });
      }
    }

    const isDownload = req.query.download === 'true' || req.query.download === '1';
    const isProxy = req.query.stream === 'proxy' || req.query.proxy === 'true';

    // 1. Check AWS S3 first if configured
    if (s3Service.isConfigured()) {
      try {
        const s3Info = await s3Service.checkRecordingExists(callId);
        if (s3Info.exists && s3Info.s3Key) {
          // Auto-sync database record
          if (call.recording_url !== `/api/calls/${callId}/audio` || call.recording_download_status !== 'done') {
            await query(
              `UPDATE calls SET recording_url = $1, recording_download_status = 'done' WHERE id = $2`,
              [`/api/calls/${callId}/audio`, callId]
            ).catch(() => {});
          }

          if (isDownload) {
            if (isProxy) {
              const s3StreamInfo = await s3Service.getS3Stream(s3Info.s3Key);
              res.setHeader('Content-Type', s3Info.contentType || 'audio/mpeg');
              res.setHeader('Content-Disposition', `attachment; filename="call-${callId}.mp3"`);
              if (s3StreamInfo.contentLength) {
                res.setHeader('Content-Length', s3StreamInfo.contentLength);
              }
              return s3StreamInfo.stream.pipe(res);
            }
            const downloadUrl = await s3Service.getPresignedDownloadUrl(s3Info.s3Key, `call-${callId}.mp3`);
            return res.redirect(downloadUrl);
          }

          // Browser Audio Player (<audio> element)
          if (isProxy) {
            const s3StreamInfo = await s3Service.getS3Stream(s3Info.s3Key, req.headers.range);
            res.status(s3StreamInfo.statusCode);
            res.setHeader('Content-Type', s3StreamInfo.contentType);
            res.setHeader('Accept-Ranges', 'bytes');
            if (s3StreamInfo.contentRange) {
              res.setHeader('Content-Range', s3StreamInfo.contentRange);
            }
            if (s3StreamInfo.contentLength) {
              res.setHeader('Content-Length', s3StreamInfo.contentLength);
            }
            return s3StreamInfo.stream.pipe(res);
          }

          const playbackUrl = await s3Service.getPresignedPlaybackUrl(s3Info.s3Key);
          return res.redirect(playbackUrl);
        }
      } catch (s3Err: any) {
        logger.warn({ callId, err: s3Err.message }, 'Failed reading recording from S3, falling back to local storage');
      }
    }

    // 2. Check local disk fallback
    const storageDir = getRecordingsDir();
    const possibleFiles = [
      path.join(storageDir, `${callId}.mp3`),
      path.join(storageDir, `${callId}.wav`),
    ];

    let filePath: string | null = null;
    for (const f of possibleFiles) {
      if (fs.existsSync(f)) {
        try {
          const sz = fs.statSync(f).size;
          if (sz > 44) {
            filePath = f;
            break;
          }
        } catch {}
      }
    }

    if (filePath) {
      const isWav = filePath.toLowerCase().endsWith('.wav');
      const contentType = isWav ? 'audio/wav' : 'audio/mpeg';

      // Auto-upload local recording to AWS S3 in background if S3 is configured
      if (s3Service.isConfigured()) {
        const s3Key = s3Service.getKeyForCall(callId, isWav ? 'wav' : 'mp3');
        s3Service.uploadFile(filePath, s3Key, contentType, { 'call-id': callId }).catch((e) => {
          logger.warn({ callId, err: e.message }, 'Background upload of local recording to S3 failed');
        });
      }

      // Auto-sync database record if audio exists
      if (call.recording_url !== `/api/calls/${callId}/audio` || call.recording_download_status !== 'done') {
        await query(`UPDATE calls SET recording_url = $1, recording_download_status = 'done' WHERE id = $2`, [`/api/calls/${callId}/audio`, callId]).catch(() => {});
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;

      if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="call-${callId}.${isWav ? 'wav' : 'mp3'}"`);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', fileSize);
        return fs.createReadStream(filePath).pipe(res);
      }

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
          'Content-Type': contentType,
        };
        res.writeHead(206, head);
        return file.pipe(res);
      } else {
        const head = {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
        };
        res.writeHead(200, head);
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    // 3. Fallback to external URL if recorded remotely (e.g. direct Exotel URL)
    const recUrl = call.recording_url;
    if (recUrl && (recUrl.startsWith('http://') || recUrl.startsWith('https://')) && !recUrl.includes('/api/calls/')) {
      return res.redirect(recUrl);
    }

    // 4. Fallback to Exotel API if exotel_call_sid exists
    const exotelSidRes = await query('SELECT exotel_call_sid FROM calls WHERE id = $1', [callId]);
    const exotelSid = exotelSidRes.rows[0]?.exotel_call_sid;
    if (exotelSid) {
      try {
        const exotelDetails = await fetchExotelCallDetails(exotelSid);
        if (exotelDetails.recordingUrl) {
          await query(
            `UPDATE calls SET recording_url = $1, recording_download_status = 'done' WHERE id = $2`,
            [exotelDetails.recordingUrl, callId]
          );
          return res.redirect(exotelDetails.recordingUrl);
        }
      } catch {}
    }

    return res.status(404).json({
      error: 'Recording audio file is still being processed or unavailable',
      status: call.recording_download_status || 'pending',
    });
  } catch (err) {
    return next(err);
  }
});

// POST & GET /api/exotel/recording-callback & /api/webhooks/exotel - Real-time webhook from Exotel
callsRouter.all(
  ['/api/exotel/recording-callback', '/api/webhooks/exotel'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload: Record<string, any> = { ...req.query, ...req.body };
      logger.info({ payload }, 'Received Exotel recording callback');

      const CallSid = payload.CallSid || payload.CallSID || payload['Stream[StreamSID]'] || payload.Stream?.StreamSID;
      const RecordingUrl =
        payload['Stream[RecordingUrl]'] ||
        payload.RecordingUrl ||
        payload.Stream?.RecordingUrl ||
        payload.recording_url;
      const RecordingDuration =
        payload['Stream[Duration]'] ||
        payload.RecordingDuration ||
        payload.Stream?.Duration ||
        payload.Duration;
      const To = payload.To || payload.to;
      const From = payload.From || payload.from;
      const CustomField = payload.CustomField || payload.custom_field;

      if (!RecordingUrl) {
        logger.warn({ payload }, 'Missing RecordingUrl in Exotel webhook payload');
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