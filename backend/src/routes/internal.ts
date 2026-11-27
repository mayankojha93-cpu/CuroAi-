import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { callService } from '../services/callService.js';
import { realEstateCallService } from '../services/realEstateCallService.js';
import { logisticsCallService } from '../services/logisticsCallService.js';
import { query } from '../db/index.js';
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
    failure_reason: z.string().nullable().optional(),
    recording_url: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    initial_language: z.string().nullable().optional(),
    language_switched: z.boolean().nullable().optional(),
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

// GET /internal/calls/active-dialing  (was unauthenticated: exposed callee phone numbers)
internalRouter.get('/internal/calls/active-dialing', requireInternalSecret, async (req: Request, res: Response) => {
  const result = await query(
    `SELECT c.id, c.room_name, c.exotel_call_sid, COALESCE(cust.phone, rl.phone, lt.driver_phone) as phone
     FROM calls c
     LEFT JOIN customers cust ON c.customer_id = cust.id
     LEFT JOIN real_estate_leads rl ON c.re_lead_id = rl.id
     LEFT JOIN logistics_trips lt ON c.logistics_trip_id = lt.id
     WHERE c.status = 'dialing'
     ORDER BY c.created_at DESC LIMIT 1`
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'No dialing call found' });
  }
  return res.json(result.rows[0]);
});

// GET /internal/calls/by-sid/:sid
internalRouter.get('/internal/calls/by-sid/:sid', requireInternalSecret, async (req: Request, res: Response) => {
  const { sid } = req.params;
  const result = await query(
    `SELECT c.id, c.room_name, c.exotel_call_sid, COALESCE(cust.phone, rl.phone, lt.driver_phone) as phone
     FROM calls c
     LEFT JOIN customers cust ON c.customer_id = cust.id
     LEFT JOIN real_estate_leads rl ON c.re_lead_id = rl.id
     LEFT JOIN logistics_trips lt ON c.logistics_trip_id = lt.id
     WHERE c.exotel_call_sid = $1 OR c.sip_call_id = $1
     ORDER BY c.created_at DESC LIMIT 1`,
    [sid]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Call not found' });
  }
  return res.json(result.rows[0]);
});

// POST /internal/calls/:callId/outcome - Idempotent outcome save
// POST /internal/real-estate/calls/:callId/outcome - Save real estate call outcome
internalRouter.post(
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

// POST /internal/real-estate/calls/:callId/turn - Incrementally save turn
internalRouter.post(
  '/internal/real-estate/calls/:callId/turn',
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      const { callId } = req.params;
      const { role, text, timestamp } = req.body;
      if (!text) {
        return res.status(400).json({ error: 'Turn text is required' });
      }
      await realEstateCallService.appendTurn(callId, { role, text, timestamp });
      return res.status(200).json({ success: true, message: 'Turn appended' });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /internal/real-estate/calls/:callId/state - Incrementally persist conversation state & slots
internalRouter.post(
  '/internal/real-estate/calls/:callId/state',
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      await realEstateCallService.savePartialState(req.params.callId, req.body || {});
      return res.status(200).json({ success: true, message: 'State synced' });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /internal/calls/:callId/turn - Incrementally save turn (Airtel or RE)
internalRouter.post(
  '/internal/calls/:callId/turn',
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      const { callId } = req.params;
      const { role, text, timestamp } = req.body;
      if (!text) {
        return res.status(400).json({ error: 'Turn text is required' });
      }
      const callRes = await query('SELECT re_lead_id, logistics_trip_id FROM calls WHERE id = $1', [callId]);
      if (callRes.rows[0]?.logistics_trip_id) {
        await logisticsCallService.appendTurn(callId, { role, text, timestamp });
      } else if (callRes.rows[0]?.re_lead_id) {
        await realEstateCallService.appendTurn(callId, { role, text, timestamp });
      } else {
        await callService.appendTurn(callId, { role, text, timestamp });
      }
      return res.status(200).json({ success: true, message: 'Turn appended' });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /internal/calls/:callId/state - Incrementally persist Airtel conversation state
internalRouter.post(
  '/internal/calls/:callId/state',
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      await callService.savePartialState(req.params.callId, req.body || {});
      return res.status(200).json({ success: true, message: 'State synced' });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /internal/logistics/calls/:callId/outcome - Save logistics call outcome
internalRouter.post(
  '/internal/logistics/calls/:callId/outcome',
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      const outcome = await logisticsCallService.saveOutcome(req.params.callId, req.body);
      return res.status(200).json({
        success: true,
        message: 'Logistics call outcome saved successfully',
        outcome,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /internal/logistics/calls/:callId/turn - Incrementally save turn
internalRouter.post(
  '/internal/logistics/calls/:callId/turn',
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      const { callId } = req.params;
      const { role, text, timestamp } = req.body;
      if (!text) {
        return res.status(400).json({ error: 'Turn text is required' });
      }
      await logisticsCallService.appendTurn(callId, { role, text, timestamp });
      return res.status(200).json({ success: true, message: 'Turn appended' });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /internal/real-estate/calls/:callId/answered - Mark call as active/answered
internalRouter.post(
  ['/internal/real-estate/calls/:callId/answered', '/internal/calls/:callId/answered'],
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      const { callId } = req.params;
      await query(
        `UPDATE calls
         SET status = 'answered',
             call_status = 'answered',
             answered_at = COALESCE(answered_at, NOW())
         WHERE id = $1 AND status IN ('initiated', 'dialing')`,
        [callId]
      );
      logger.info({ callId }, `📞 [CALL ANSWERED] Telephony answered by customer | Call ID: ${callId}`);
      return res.status(200).json({ success: true, message: 'Real estate call marked as answered' });
    } catch (err) {
      return next(err);
    }
  }
);

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

// GET /internal/calls/:callId - Lookup call and customer details
internalRouter.get(
  '/internal/calls/:callId',
  requireInternalSecret,
  async (req: Request<{ callId: string }>, res: Response, next: NextFunction) => {
    try {
      const call = await callService.getCall(req.params.callId);
      let logisticsTrip: any = null;
      if (call.logistics_trip_id) {
        const tripRes = await query('SELECT * FROM logistics_trips WHERE id = $1', [call.logistics_trip_id]);
        logisticsTrip = tripRes.rows[0] || null;
      }
      return res.status(200).json({
        success: true,
        call,
        callId: call.id,
        leadId: call.re_lead_id || call.customer_id,
        customerId: call.customer_id,
        logisticsTrip,
        customerName: logisticsTrip?.driver_name || call.customer_name,
        ownerName: call.customer_name,
        phone: logisticsTrip?.driver_phone || call.customer_phone || call.phone,
        preferredLanguage: call.language || 'en',
        language: call.language || 'en',
        ttsProvider: (call as any).tts_provider || 'sarvam',
        tts_provider: (call as any).tts_provider || 'sarvam',
        propertyLocation: call.property_location || call.customer_address,
        address: call.customer_address || call.property_location,
        location: call.property_location,
        category: call.re_category || call.category || 'residential',
        propertyCategory: call.re_category || call.category || 'residential',
        direction: call.direction || 'outbound',
        accountNo: call.account_no,
        subsDelNo: call.subs_del_no,
        serviceEndDate: call.service_end_date,
        rDate: call.r_date,
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
