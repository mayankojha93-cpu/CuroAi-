import { randomUUID } from 'crypto';
import {
  SipClient,
  AgentDispatchClient,
  RoomServiceClient,
  SipCallError,
  WebhookReceiver,
} from 'livekit-server-sdk';
import { ParticipantInfo_Kind } from '@livekit/protocol';
import { pool, query } from '../db/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { normalizeDate, normalizePhone, extractPincode } from '../utils/csvParser.js';
import {
  matchCanonicalDisposition,
  isTerminalDisposition,
  CANONICAL_DISPOSITIONS,
  TERMINAL_DISPOSITIONS,
} from '../utils/dispositions.js';

export interface CallRecord {
  id: string;
  customer_id: string;
  status: string;
  room_name: string;
  sip_call_id: string | null;
  direction?: 'inbound' | 'outbound';
  failure_reason: string | null;
  attempt_number?: number;
  duration_seconds?: number;
  call_status?: string;
  recording_url?: string | null;
  script?: string | null;
  company_name?: string | null;
  voice_pipeline?: string | null;
  is_test_call?: boolean;
  median_latency_ms?: number | null;
  cost_estimate_inr?: number | null;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

export interface SaveOutcomeInput {
  outcome?: string;
  final_disposition: string;
  identity_confirmed?: boolean | null;
  pickup_accepted?: boolean | null;
  proposed_date?: string | null;
  confirmed_date?: string | null;
  pickup_date?: string | null;
  registered_address_confirmed?: boolean | null;
  address_confirmed?: boolean | null;
  new_address?: string | null;
  corrected_address?: string | null;
  alternate_phone?: string | null;
  customer_note?: string | null;
  escalation_required?: boolean | null;
  transcript_reference?: string | null;
  transcript?: any;
  duration_seconds?: number | null;
  median_latency_ms?: number | null;
  cost_estimate_inr?: number | null;
  recording_url?: string | null;
}

export interface LeadInput {
  name?: string;
  phone?: string;
  address?: string;
  language?: string;
  account_no?: string;
  subs_del_no?: string;
  service_end_date?: string;
  r_date?: string;
  check?: string;
  check_status?: string;
  cust_email?: string;
  customer_identifier?: string;
  alternate_phones?: string[];
  alternate_phone?: string;
  pincode?: string;
  zone?: string;
  town_flag?: string;
  service_city?: string;
  disconnection_reason?: string;
  circle_new?: string;
  circle_new20?: string;
  allocated_to?: string;
  product_name?: string;
}

// A call in 'initiated' / 'dialing' / 'answered' younger than this blocks another dial to the same customer
const ACTIVE_CALL_WINDOW_MINUTES = 10;

// ───────────────────────── helpers ─────────────────────────

/**
 * pg returns DATE columns as JS Date objects (local midnight). Calling .toString() or JSON-serialising
 * them gives "Thu Aug 27 2026 ..." or a UTC ISO string that is one day off in IST.
 * Always send plain YYYY-MM-DD to the agent / API consumers.
 */
function ymd(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
}

function serializeCustomer<T extends Record<string, any> | null | undefined>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    service_end_date: ymd(row.service_end_date) || null,
    r_date: ymd(row.r_date) || null,
  } as T;
}

/**
 * LiveKit SIP participants are named `sip_<number>` for inbound calls (outbound ones are `phone-<number>`
 * because we set the identity ourselves). The real caller number is in the `sip.phoneNumber` attribute.
 */
function extractPhone(value?: string | null): string {
  if (!value) return '';
  return value.replace(/^(phone-|sip_|sip:)/i, '').trim();
}

function isSipParticipant(p: any): boolean {
  if (!p) return false;
  return (
    p.kind === ParticipantInfo_Kind.SIP ||
    (typeof p.identity === 'string' && (p.identity.startsWith('phone-') || p.identity.startsWith('sip_')))
  );
}

export class CallService {
  private sipClient: SipClient;
  private dispatchClient: AgentDispatchClient;
  private roomService: RoomServiceClient;
  private webhookReceiver: WebhookReceiver;

  constructor() {
    this.sipClient = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    this.dispatchClient = new AgentDispatchClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    this.roomService = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    this.webhookReceiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }

  /**
   * Initiates an outbound phone call to the customer.
   */
  async initiateCall(customerId: string): Promise<CallRecord> {
    const custRes = await query(
      `SELECT id, name, phone, address, language, account_no, subs_del_no,
              service_end_date, r_date, total_attempts, max_attempts, is_closed, current_disposition
       FROM customers WHERE id = $1`,
      [customerId]
    );

    if (custRes.rows.length === 0) {
      throw new AppError(`Customer not found with ID: ${customerId}`, 404);
    }
    const customer = custRes.rows[0];

    if (customer.is_closed) {
      logger.warn({ customerId, disposition: customer.current_disposition }, 'Customer is already closed/dispositioned');
    }

    const callId = randomUUID();
    const roomName = `call-${callId}`;

    // ── Duplicate-dial guard ──────────────────────────────────────────────────────────────────────
    // A double click / double request used to place two simultaneous calls to the same phone. The carrier
    // then played its call-waiting "on hold" announcement into the live call and the agent treated it as
    // the customer's answer. Check + insert run in ONE transaction under a per-customer advisory lock, so
    // two parallel requests cannot both pass the check. The time window stops a crashed call that never
    // reached a final status from blocking the customer forever.
    let call: CallRecord;
    let currentAttempt: number;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dial:${customerId}`]);

      const active = await client.query(
        `SELECT id, status, room_name FROM calls
         WHERE customer_id = $1
           AND (
             (status = 'answered' AND created_at > NOW() - INTERVAL '${ACTIVE_CALL_WINDOW_MINUTES} minutes')
             OR
             (status IN ('initiated', 'dialing') AND created_at > NOW() - INTERVAL '90 seconds')
           )
         ORDER BY created_at DESC
         LIMIT 1`,
        [customerId]
      );
      if (active.rows.length > 0) {
        await client.query('ROLLBACK');
        const a = active.rows[0];
        logger.warn({ customerId, activeCallId: a.id, status: a.status }, 'Duplicate dial blocked: call already in progress');
        throw new AppError(
          `A call to this customer is already in progress (call ${a.id}, status ${a.status}). Wait for it to finish before calling again.`,
          409
        );
      }

      // Increment atomically and read the new value back (no read-then-write race)
      const attemptRes = await client.query(
        'UPDATE customers SET total_attempts = COALESCE(total_attempts, 0) + 1 WHERE id = $1 RETURNING total_attempts',
        [customerId]
      );
      currentAttempt = attemptRes.rows[0].total_attempts;

      logger.info(
        { customerId, callId, roomName, phone: customer.phone, attempt: currentAttempt },
        'Initiating outbound call'
      );

      const insertRes = await client.query(
        `INSERT INTO calls (id, customer_id, campaign_id, status, call_status, attempt_number, room_name, direction)
         VALUES ($1, $2, $3, 'initiated', 'initiated', $4, $5, 'outbound')
         RETURNING *`,
        [callId, customerId, customer.campaign_id || null, currentAttempt, roomName]
      );
      call = insertRes.rows[0];
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    this.executeOutboundCallWorkflow(callId, customer, roomName, currentAttempt).catch((err) => {
      logger.error({ err, callId }, 'Unhandled error in outbound call workflow');
    });

    return call;
  }

  /**
   * Places a developer test call with customizable lead attributes.
   */
  async initiateTestCall(data: {
    phone: string;
    name?: string;
    customer_name?: string;
    company_name?: string;
    script?: string;
    voice_pipeline?: string;
    address?: string;
    account_no?: string;
    subs_del_no?: string;
    service_end_date?: string;
    r_date?: string;
    language?: string;
  }) {
    const custName = data.customer_name || data.name || 'Test Subscriber';
    const normalizedPhone = normalizePhone(data.phone, data.subs_del_no);
    const normalizedServiceEnd = normalizeDate(data.service_end_date);
    const normalizedRDate = normalizeDate(data.r_date);

    const custRes = await query(
      `INSERT INTO customers (
         name, phone, address, language, account_no, subs_del_no, service_end_date, r_date,
         total_attempts, max_attempts, next_attempt_time
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 3, NOW())
       ON CONFLICT (phone)
       DO UPDATE SET
         name = EXCLUDED.name,
         address = EXCLUDED.address,
         language = EXCLUDED.language,
         account_no = COALESCE(EXCLUDED.account_no, customers.account_no),
         subs_del_no = COALESCE(EXCLUDED.subs_del_no, customers.subs_del_no),
         service_end_date = COALESCE(EXCLUDED.service_end_date, customers.service_end_date),
         r_date = COALESCE(EXCLUDED.r_date, customers.r_date)
       RETURNING *`,
      [
        custName,
        normalizedPhone,
        data.address || (data.company_name ? `${data.company_name} HQ` : 'Delhi, 110011, burari, sant nagar'),
        data.language || 'en',
        data.account_no || '20022941256',
        data.subs_del_no || '01121344121_wifi',
        normalizedServiceEnd || '2026-08-27',
        normalizedRDate || '2026-08-29',
      ]
    );

    const customer = custRes.rows[0];

    // For test calls, automatically resolve any lingering dialing/initiated calls for this customer
    // so testers can immediately trigger a new test call without waiting
    await query(
      `UPDATE calls 
       SET status = 'no_answer', call_status = 'no_answer', ended_at = NOW() 
       WHERE customer_id = $1 AND status IN ('initiated', 'dialing')`,
      [customer.id]
    );

    const call = await this.initiateCall(customer.id);

    const scriptName = data.script || 'Trump Towers India — Real Estate';
    const voicePipeline = data.voice_pipeline || 'HABot Pipeline';
    const companyName = data.company_name || (data.script?.includes('Trump') ? 'Trump Towers India' : (data.script?.includes('Ratnafin') ? 'Ratnafin' : 'Airtel'));

    await query(
      `UPDATE calls 
       SET script = $1, company_name = $2, voice_pipeline = $3, is_test_call = TRUE 
       WHERE id = $4`,
      [scriptName, companyName, voicePipeline, call.id]
    );

    call.script = scriptName;
    call.company_name = companyName;
    call.voice_pipeline = voicePipeline;
    call.is_test_call = true;

    return { call, customer: serializeCustomer(customer) };
  }

  /**
   * Looks up a customer by phone number.
   * Safe against withheld / short numbers: never falls back to LIKE '%' (which would match ANY customer
   * and leak another subscriber's account details to an anonymous caller).
   */
  async lookupCustomerByPhone(phone: string) {
    const cleaned = extractPhone(phone);
    if (!cleaned) return null;
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length < 10) return null;

    const normalized = normalizePhone(cleaned);
    const last10 = digits.slice(-10);

    const res = await query(
      `SELECT * FROM customers
       WHERE phone = $1
          OR phone = $2
          OR phone LIKE $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [normalized, digits, `%${last10}`]
    );

    return serializeCustomer(res.rows[0]) || null;
  }

  /**
   * Registers an inbound call session. IDEMPOTENT per room_name.
   * Both the LiveKit webhook and the voice agent call this for the same room; previously each one
   * inserted its own `calls` row, so every inbound call was stored twice and the outcome ended up
   * on a different row than the one the webhook updated.
   */
  async registerInboundCall(data: { roomName: string; phone?: string; sipCallId?: string }) {
    const rawPhone = extractPhone(data.phone);
    const digits = rawPhone.replace(/\D/g, '');

    let customer: any = rawPhone ? await this.lookupCustomerByPhone(rawPhone) : null;

    // Unknown caller with a real number: keep a record, but CLOSED so the outbound retry queue
    // (getPendingRetries) never dials a random inbound caller.
    if (!customer && digits.length >= 10) {
      try {
        const normalizedPhone = normalizePhone(rawPhone);
        const defaultName = `Inbound Caller (${digits.slice(-4)})`;
        const ins = await query(
          `INSERT INTO customers (name, phone, address, language, total_attempts, max_attempts, is_closed, next_attempt_time)
           VALUES ($1, $2, 'Pending address verification', 'hi', 0, 3, TRUE, NULL)
           ON CONFLICT (phone) DO UPDATE SET name = customers.name
           RETURNING *`,
          [defaultName, normalizedPhone]
        );
        customer = serializeCustomer(ins.rows[0]);
      } catch (e) {
        logger.warn({ e, phone: rawPhone }, 'Could not auto-insert inbound customer record');
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise webhook vs agent registrations for the same room
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [data.roomName]);

      const existing = await client.query('SELECT * FROM calls WHERE room_name = $1 LIMIT 1', [data.roomName]);
      let call: CallRecord;

      if (existing.rows.length > 0) {
        const upd = await client.query(
          `UPDATE calls
           SET customer_id = COALESCE(customer_id, $2),
               sip_call_id = COALESCE(sip_call_id, $3),
               direction = COALESCE(direction, 'inbound')
           WHERE id = $1
           RETURNING *`,
          [existing.rows[0].id, customer?.id || null, data.sipCallId || null]
        );
        call = upd.rows[0];
      } else {
        const ins = await client.query(
          `INSERT INTO calls (id, customer_id, status, call_status, room_name, direction, sip_call_id, answered_at)
           VALUES ($1, $2, 'answered', 'answered', $3, 'inbound', $4, NOW())
           RETURNING *`,
          [randomUUID(), customer?.id || null, data.roomName, data.sipCallId || null]
        );
        call = ins.rows[0];
      }
      await client.query('COMMIT');

      // The row may already be linked to a customer that this caller's number did not resolve to
      if (!customer && call.customer_id) {
        const c = await query('SELECT * FROM customers WHERE id = $1', [call.customer_id]);
        customer = serializeCustomer(c.rows[0]) || null;
      }

      logger.info(
        { callId: call.id, roomName: data.roomName, phone: rawPhone, customerId: call.customer_id },
        'Registered inbound call session'
      );
      return { call, customer: customer || null };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Internal workflow: Creates room, dispatches agent with account metadata, dials SIP participant.
   */
  private async executeOutboundCallWorkflow(
    callId: string,
    customer: any,
    roomName: string,
    attemptNumber: number
  ) {
    try {
      await this.roomService.createRoom({ name: roomName, emptyTimeout: 300 });

      logger.info({ roomName, agentName: env.AGENT_NAME }, 'Creating agent dispatch');
      await this.dispatchClient.createDispatch(roomName, env.AGENT_NAME, {
        metadata: JSON.stringify({
          callId,
          customerId: customer.id,
          customerName: customer.name,
          address: customer.address,
          phone: customer.phone,
          preferredLanguage: customer.language || 'hi',
          accountNo: customer.account_no || '',
          subsDelNo: customer.subs_del_no || '',
          serviceEndDate: ymd(customer.service_end_date),
          rDate: ymd(customer.r_date),
          attemptNumber,
          direction: 'outbound',
        }),
      });

      if (!env.SIP_OUTBOUND_TRUNK_ID) {
        throw new Error('Missing SIP_OUTBOUND_TRUNK_ID in environment. Please configure your Exotel Outbound SIP trunk in .env');
      }

      const dialablePhone = normalizePhone(customer.phone, customer.subs_del_no);
      const callerId = env.SIP_CALLER_ID || undefined;

      await query("UPDATE calls SET status = 'dialing', call_status = 'dialing' WHERE id = $1", [callId]);
      logger.info(
        { callId, phone: dialablePhone, trunkId: env.SIP_OUTBOUND_TRUNK_ID, callerId },
        'Updated call status to dialing. Dispatching Exotel SIP call...'
      );

      const participant = await this.sipClient.createSipParticipant(
        env.SIP_OUTBOUND_TRUNK_ID,
        dialablePhone,
        roomName,
        {
          participantIdentity: `phone-${dialablePhone.replace(/[^0-9]/g, '')}`,
          participantName: customer.name,
          fromNumber: callerId,
          waitUntilAnswered: false,
        } as any
      );
      logger.info({ callId, sipCallId: participant.sipCallId }, 'Exotel SIP call dispatched to carrier!');
      await query(`UPDATE calls SET sip_call_id = $1 WHERE id = $2`, [participant.sipCallId || null, callId]);
    } catch (err: any) {
      let mappedStatus: 'NO_ANSWER' | 'BUSY' | 'FAILED' = 'FAILED';
      let failureReason = err.message || 'Call placement failed';

      if (err instanceof SipCallError) {
        failureReason = `SIP ${err.sipStatusCode} (${err.sipStatus || 'Error'}): ${err.message}`;
        if (err.sipStatusCode === 486 || err.sipStatusCode === 600) {
          mappedStatus = 'BUSY';
        } else if (err.sipStatusCode === 408 || err.sipStatusCode === 480 || err.sipStatusCode === 487) {
          mappedStatus = 'NO_ANSWER';
        } else if (err.sipStatusCode === 403) {
          failureReason = `SIP 403 Forbidden: Exotel rejected call authentication or caller ID. Check SIP credentials or ExoPhone caller ID (${env.SIP_CALLER_ID || 'Trunk Default'}).`;
          mappedStatus = 'FAILED';
        }
      } else if (err.message && err.message.toLowerCase().includes('timeout')) {
        mappedStatus = 'NO_ANSWER';
      }

      logger.warn({ callId, mappedStatus, failureReason }, 'Outbound dial failed or rejected');

      await query(
        `UPDATE calls
         SET status = $1, call_status = $1, failure_reason = $2, ended_at = NOW()
         WHERE id = $3`,
        [mappedStatus, failureReason, callId]
      );

      await this.evaluateRetry(customer.id, mappedStatus, null);

      try {
        await this.roomService.deleteRoom(roomName);
      } catch (_) {}
    }
  }

  /**
   * Evaluates the retry schedule based on Airtel retry rules.
   */
  private async evaluateRetry(customerId: string, disposition: string, _date: string | null) {
    const custRes = await query(
      `SELECT c.id, c.total_attempts, c.max_attempts, c.is_closed, c.current_disposition, c.campaign_id,
              cam.retry_attempts, cam.retry_delay_minutes
       FROM customers c
       LEFT JOIN campaigns cam ON c.campaign_id = cam.id
       WHERE c.id = $1`,
      [customerId]
    );
    if (custRes.rows.length === 0) return;
    const cust = custRes.rows[0];

    const canonical = matchCanonicalDisposition(disposition);

    if (isTerminalDisposition(canonical)) {
      await query(
        `UPDATE customers
         SET current_disposition = $1, is_closed = TRUE, next_attempt_time = NULL
         WHERE id = $2`,
        [canonical, customerId]
      );
      logger.info({ customerId, disposition: canonical }, 'Customer closed with terminal canonical disposition');
      return;
    }

    // Already closed: do not re-schedule
    if (cust.is_closed) {
      logger.info({ customerId, disposition: canonical }, 'Customer already closed; skipping retry scheduling');
      return;
    }

    // Determine effective max attempts and retry delay
    const maxAttempts = (cust.retry_attempts !== null && cust.retry_attempts !== undefined)
      ? cust.retry_attempts
      : (cust.max_attempts || 3);

    const retryDelayMinutes = (cust.retry_delay_minutes !== null && cust.retry_delay_minutes !== undefined)
      ? cust.retry_delay_minutes
      : 180;

    // "Willing To Pickup": allow ONE more follow-up call if not already reached
    if (canonical === 'Willing To Pickup' && cust.current_disposition !== 'Willing To Pickup') {
      const newMax = cust.total_attempts + 1;
      await query(
        `UPDATE customers
         SET current_disposition = $1,
             max_attempts = $2,
             is_closed = FALSE,
             next_attempt_time = NOW() + ($3 || ' minutes')::interval
         WHERE id = $4`,
        [canonical, newMax, retryDelayMinutes, customerId]
      );
      logger.info({ customerId, disposition: canonical, newMax, retryDelayMinutes }, 'Willing To Pickup: scheduled follow-up call');
      return;
    }

    if (cust.total_attempts >= maxAttempts) {
      await query(
        `UPDATE customers
         SET current_disposition = $1, is_closed = TRUE, next_attempt_time = NULL
         WHERE id = $2`,
        [canonical, customerId]
      );
      logger.info({ customerId, attempts: cust.total_attempts, maxAttempts, disposition: canonical }, 'Max attempts reached. Closed customer');
      return;
    }

    // Retries apply to every non-terminal result
    await query(
      `UPDATE customers
       SET current_disposition = $1,
           is_closed = FALSE,
           next_attempt_time = NOW() + ($2 || ' minutes')::interval
       WHERE id = $3`,
      [canonical, retryDelayMinutes, customerId]
    );

    logger.info({ customerId, disposition: canonical, attempt: cust.total_attempts, maxAttempts, retryDelayMinutes }, 'Scheduled next retry attempt for customer');
  }

  /**
   * Idempotent save outcome handler with Airtel canonical disposition & retry logic.
   */
  async saveOutcome(callId: string, data: SaveOutcomeInput) {
    const rawDisp = data.final_disposition || data.outcome || (data.duration_seconds && data.duration_seconds > 0 ? 'Abruptly Disconnected Call' : 'Not Connected (No Answer)');
    
    const callRes = await query('SELECT id, customer_id, campaign_id, status FROM calls WHERE id = $1', [callId]);
    if (callRes.rows.length === 0) {
      throw new AppError(`Call not found: ${callId}`, 404);
    }
    const call = callRes.rows[0];

    const finalDisp = matchCanonicalDisposition(rawDisp, data.duration_seconds, call.status);
    logger.info({ callId, rawDisposition: rawDisp, canonicalDisposition: finalDisp }, 'Saving call outcome (canonical)');

    // Ensure campaign_id is linked if customer belongs to a campaign
    if (!call.campaign_id && call.customer_id) {
      const custCampRes = await query('SELECT campaign_id FROM customers WHERE id = $1', [call.customer_id]);
      if (custCampRes.rows[0]?.campaign_id) {
        call.campaign_id = custCampRes.rows[0].campaign_id;
        await query('UPDATE calls SET campaign_id = $1 WHERE id = $2', [call.campaign_id, callId]);
      }
    }

    const transcriptJson = data.transcript ? JSON.stringify(data.transcript) : null;
    const baseOutcome = data.outcome || finalDisp.toLowerCase();

    const outcomeRes = await query(
      `INSERT INTO call_outcomes (
         call_id, outcome, pickup_date, address_confirmed, corrected_address, transcript,
         identity_confirmed, pickup_accepted, proposed_date, confirmed_date,
         registered_address_confirmed, new_address, alternate_phone,
         final_disposition, customer_note, escalation_required, transcript_reference
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (call_id)
       DO UPDATE SET
         outcome = EXCLUDED.outcome,
         pickup_date = EXCLUDED.pickup_date,
         address_confirmed = EXCLUDED.address_confirmed,
         corrected_address = EXCLUDED.corrected_address,
         transcript = EXCLUDED.transcript,
         identity_confirmed = EXCLUDED.identity_confirmed,
         pickup_accepted = EXCLUDED.pickup_accepted,
         proposed_date = EXCLUDED.proposed_date,
         confirmed_date = EXCLUDED.confirmed_date,
         registered_address_confirmed = EXCLUDED.registered_address_confirmed,
         new_address = EXCLUDED.new_address,
         alternate_phone = EXCLUDED.alternate_phone,
         final_disposition = EXCLUDED.final_disposition,
         customer_note = EXCLUDED.customer_note,
         escalation_required = EXCLUDED.escalation_required,
         transcript_reference = EXCLUDED.transcript_reference
       RETURNING *`,
      [
        callId,
        baseOutcome,
        data.confirmed_date || data.proposed_date || data.pickup_date || null,
        data.registered_address_confirmed ?? data.address_confirmed ?? null,
        data.new_address || data.corrected_address || null,
        transcriptJson,
        data.identity_confirmed ?? null,
        data.pickup_accepted ?? null,
        data.proposed_date || null,
        data.confirmed_date || null,
        data.registered_address_confirmed ?? null,
        data.new_address || null,
        data.alternate_phone || null,
        finalDisp,
        data.customer_note || null,
        data.escalation_required ?? false,
        data.transcript_reference || null,
      ]
    );

    const duration = data.duration_seconds || 0;
    const medianLatency = data.median_latency_ms || null;
    const costEstimate = data.cost_estimate_inr || (duration > 0 ? (duration / 60) * 2.4 : 0.04);

    // Map into the 3 standard statuses: 'completed' (Successful), 'failed' (Failed), 'no_answer' (No Answer)
    let mappedStatus = 'completed';
    if (finalDisp === 'Not Connected (No Answer)' || finalDisp === 'Voicemail or IVR Detected') {
      mappedStatus = 'no_answer';
    } else if (
      finalDisp === 'Not Connected (Failed)' ||
      finalDisp === 'Refused To Return' ||
      finalDisp === 'Wrong Number' ||
      finalDisp === 'Language Barrier' ||
      finalDisp === 'Do Not Call' ||
      finalDisp === 'Abruptly Disconnected Call' ||
      data.escalation_required
    ) {
      mappedStatus = 'failed';
    } else {
      mappedStatus = 'completed';
    }

    await query(
      `UPDATE calls
       SET status = $1,
           call_status = $2,
           duration_seconds = $3,
           median_latency_ms = $4,
           cost_estimate_inr = $5,
           recording_url = COALESCE($6, recording_url),
           answered_at = COALESCE(answered_at, CASE WHEN $3 > 0 THEN NOW() - ($3 || ' seconds')::interval ELSE NOW() END),
           ended_at = COALESCE(ended_at, NOW())
       WHERE id = $7`,
      [mappedStatus, finalDisp, duration, medianLatency, costEstimate, data.recording_url || null, callId]
    );

    // Update campaign counters if call is associated with a campaign
    if (call.campaign_id) {
      if (mappedStatus === 'completed') {
        await query(
          `UPDATE campaigns
           SET successful_calls = successful_calls + 1,
               remaining_calls = GREATEST(0, remaining_calls - 1),
               unique_called = unique_called + 1,
               credits_used = credits_used + 1,
               progress_percent = LEAST(100, ROUND(((unique_called + 1)::numeric / GREATEST(total_contacts, 1)::numeric) * 100)),
               updated_at = NOW()
           WHERE id = $1`,
          [call.campaign_id]
        );
      } else if (mappedStatus === 'failed') {
        await query(
          `UPDATE campaigns
           SET failed_calls = failed_calls + 1,
               remaining_calls = GREATEST(0, remaining_calls - 1),
               unique_called = unique_called + 1,
               progress_percent = LEAST(100, ROUND(((unique_called + 1)::numeric / GREATEST(total_contacts, 1)::numeric) * 100)),
               updated_at = NOW()
           WHERE id = $1`,
          [call.campaign_id]
        );
      } else {
        await query(
          `UPDATE campaigns
           SET unique_called = unique_called + 1,
               progress_percent = LEAST(100, ROUND(((unique_called + 1)::numeric / GREATEST(total_contacts, 1)::numeric) * 100)),
               updated_at = NOW()
           WHERE id = $1`,
          [call.campaign_id]
        );
      }
    }

    if (call.customer_id) {
      await this.evaluateRetry(call.customer_id, finalDisp, data.confirmed_date || null);
    }

    return outcomeRes.rows[0];
  }

  /**
   * Fetches pending customers for retries.
   */
  async getPendingRetries(limit = 50) {
    const res = await query(
      `SELECT * FROM customers
       WHERE is_closed = FALSE
         AND total_attempts < max_attempts
         AND (next_attempt_time IS NULL OR next_attempt_time <= NOW())
       ORDER BY next_attempt_time ASC NULLS FIRST
       LIMIT $1`,
      [limit]
    );
    return res.rows.map((r: any) => serializeCustomer(r));
  }

  /**
   * Bulk import leads matching Excel sheet columns.
   */
  async importLeads(leads: LeadInput[]) {
    const inserted = [];
    for (const lead of leads) {
      const normalizedPhone = normalizePhone(lead.phone, lead.subs_del_no);
      const normalizedServiceEnd = normalizeDate(lead.service_end_date);
      const normalizedRDate = normalizeDate(lead.r_date);
      const name = (lead.name && lead.name.trim()) || 'Airtel Subscriber';
      const address = (lead.address && lead.address.trim()) || 'Address On Record';

      const custEmail = lead.cust_email || null;
      const custIdentifier = lead.customer_identifier || lead.account_no || null;
      const altPhones = Array.isArray(lead.alternate_phones) && lead.alternate_phones.length > 0 ? lead.alternate_phones : (lead.alternate_phone ? [lead.alternate_phone] : null);
      const primaryAlt = lead.alternate_phone || (altPhones && altPhones[0]) || null;
      const pincode = (lead.pincode && lead.pincode.trim()) || extractPincode(address) || null;
      const zone = (lead.zone && lead.zone.trim()) || null;
      const townFlag = (lead.town_flag && lead.town_flag.trim()) || null;
      const serviceCity = (lead.service_city && lead.service_city.trim()) || null;
      const disconnectionReason = (lead.disconnection_reason && lead.disconnection_reason.trim()) || null;
      const circleNew = (lead.circle_new && lead.circle_new.trim()) || null;
      const circleNew20 = (lead.circle_new20 && lead.circle_new20.trim()) || null;
      const allocatedTo = (lead.allocated_to && lead.allocated_to.trim()) || null;
      const checkStatus = (lead.check_status || lead.check || '').trim() || null;
      const productName = (lead.product_name && lead.product_name.trim()) || 'Airtel IP TV';

      const res = await query(
        `INSERT INTO customers (
           name, phone, address, language, account_no, subs_del_no, service_end_date, r_date,
           cust_email, customer_identifier, alternate_phones, alternate_phone,
           pincode, zone, town_flag, service_city, disconnection_reason, circle_new, circle_new20, allocated_to, check_status, product_name,
           total_attempts, max_attempts, next_attempt_time
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 0, 3, NOW())
         ON CONFLICT (phone)
         DO UPDATE SET
           name = EXCLUDED.name,
           address = EXCLUDED.address,
           account_no = COALESCE(EXCLUDED.account_no, customers.account_no),
           subs_del_no = COALESCE(EXCLUDED.subs_del_no, customers.subs_del_no),
           service_end_date = COALESCE(EXCLUDED.service_end_date, customers.service_end_date),
           r_date = COALESCE(EXCLUDED.r_date, customers.r_date),
           cust_email = COALESCE(EXCLUDED.cust_email, customers.cust_email),
           customer_identifier = COALESCE(EXCLUDED.customer_identifier, customers.customer_identifier),
           alternate_phones = COALESCE(EXCLUDED.alternate_phones, customers.alternate_phones),
           alternate_phone = COALESCE(EXCLUDED.alternate_phone, customers.alternate_phone),
           pincode = COALESCE(EXCLUDED.pincode, customers.pincode),
           zone = COALESCE(EXCLUDED.zone, customers.zone),
           town_flag = COALESCE(EXCLUDED.town_flag, customers.town_flag),
           service_city = COALESCE(EXCLUDED.service_city, customers.service_city),
           disconnection_reason = COALESCE(EXCLUDED.disconnection_reason, customers.disconnection_reason),
           circle_new = COALESCE(EXCLUDED.circle_new, customers.circle_new),
           circle_new20 = COALESCE(EXCLUDED.circle_new20, customers.circle_new20),
           allocated_to = COALESCE(EXCLUDED.allocated_to, customers.allocated_to),
           check_status = COALESCE(EXCLUDED.check_status, customers.check_status),
           product_name = COALESCE(EXCLUDED.product_name, customers.product_name)
         RETURNING *`,
        [
          name,
          normalizedPhone,
          address,
          lead.language || 'hi',
          lead.account_no || custIdentifier || null,
          lead.subs_del_no || null,
          normalizedServiceEnd,
          normalizedRDate,
          custEmail,
          custIdentifier,
          altPhones,
          primaryAlt,
          pincode,
          zone,
          townFlag,
          serviceCity,
          disconnectionReason,
          circleNew,
          circleNew20,
          allocatedTo,
          checkStatus,
          productName,
        ]
      );
      inserted.push(serializeCustomer(res.rows[0]));
    }
    return inserted;
  }

  /**
   * Generates the campaign summary: "Airtel IP TV Urgent Campaign Summary"
   */
  async getCampaignSummary() {
    const totalCustomersRes = await query('SELECT COUNT(*) as count, COUNT(DISTINCT phone) as unique_contacts FROM customers');
    const totalCallsRes = await query(
      `SELECT COUNT(*) as attempts,
              COUNT(*) FILTER (WHERE status IN ('answered', 'completed', 'COMPLETED')) as connected
       FROM calls`
    );
    const dispositionedRes = await query(
      `SELECT COUNT(*) as count FROM customers
       WHERE is_closed = TRUE OR COALESCE(current_disposition, 'PENDING') != 'PENDING'`
    );

    const dispositionsQuery = await query(`
      SELECT current_disposition, COUNT(*) as count
      FROM customers
      WHERE current_disposition IS NOT NULL AND current_disposition != 'PENDING'
      GROUP BY current_disposition
    `);

    const dispMap: Record<string, number> = {};
    for (const r of dispositionsQuery.rows) {
      dispMap[r.current_disposition] = parseInt(r.count, 10);
    }

    const sourceRows = parseInt(totalCustomersRes.rows[0]?.count || '0', 10);
    const uniqueContacts = parseInt(totalCustomersRes.rows[0]?.unique_contacts || '0', 10);
    const connectedCalls = parseInt(totalCallsRes.rows[0]?.connected || '0', 10);
    const totalAttempts = parseInt(totalCallsRes.rows[0]?.attempts || '0', 10);
    const dispositionedContacts = parseInt(dispositionedRes.rows[0]?.count || '0', 10);

    return {
      overview: { sourceRows, uniqueContacts, connectedCalls, totalAttempts, dispositionedContacts },
      categories: [
        {
          category: 'Ready For Pickup',
          dispositions: [
            {
              name: 'Confirmed For Pickup',
              count: (dispMap['CONFIRMED_FOR_PICKUP'] || 0) + (dispMap['PICKUP_CONFIRMED'] || 0) + (dispMap['PICKUP_CONFIRMED_NEW_DATE'] || 0),
            },
            { name: 'Willing To Pickup', count: dispMap['WILLING_TO_PICKUP'] || 0 },
            { name: 'Shifted - Device With Customer', count: dispMap['SHIFTED_DEVICE_WITH_CUSTOMER'] || 0 },
            { name: 'Shifted - Device With Relative', count: dispMap['SHIFTED_DEVICE_WITH_RELATIVE'] || 0 },
            { name: 'Shifted - Device Left At Previous Address', count: dispMap['SHIFTED_DEVICE_LEFT_PREVIOUS'] || 0 },
          ],
        },
        {
          category: 'Scheduled Callback',
          dispositions: [{ name: 'Schedule Callback', count: dispMap['SCHEDULE_CALLBACK'] || 0 }],
        },
        {
          category: 'Will Not Return',
          dispositions: [
            { name: 'Already Returned Device', count: (dispMap['ALREADY_RETURNED'] || 0) + (dispMap['ALREADY_PICKED_UP'] || 0) },
            { name: 'Refused To Return', count: (dispMap['REFUSED_TO_RETURN'] || 0) + (dispMap['PICKUP_DECLINED'] || 0) },
            { name: 'Willing To Recharge', count: dispMap['WILLING_TO_RECHARGE'] || 0 },
            { name: 'Already Recharged', count: (dispMap['RECHARGED_DEVICE'] || 0) + (dispMap['ALREADY_RECHARGED'] || 0) },
            { name: 'Damaged Device', count: dispMap['DAMAGED_DEVICE'] || 0 },
            { name: 'Lost Device', count: dispMap['LOST_DEVICE'] || 0 },
            { name: 'Refund Request', count: (dispMap['REFUND_REQUEST'] || 0) + (dispMap['REFUND_OR_OWNERSHIP_QUERY'] || 0) },
            { name: 'Already Using Device', count: dispMap['ALREADY_USING_DEVICE'] || 0 },
          ],
        },
        {
          category: 'Other Customer Outcomes',
          dispositions: [
            { name: 'Wrong Number', count: (dispMap['WRONG_NUMBER'] || 0) + (dispMap['WRONG_NUMBER_OR_IDENTITY_NOT_CONFIRMED'] || 0) },
            { name: 'Complaint / Escalated To 121', count: (dispMap['NEEDS_AIRTEL_SUPPORT'] || 0) + (dispMap['COMPLAINT_ESCALATION'] || 0) },
            { name: 'Language Barrier', count: dispMap['LANGUAGE_BARRIER'] || 0 },
            { name: 'Do Not Call', count: dispMap['DO_NOT_CALL'] || 0 },
            { name: 'Abruptly Disconnected Call', count: dispMap['DISCONNECTED'] || 0 },
          ],
        },
        {
          category: "Customer couldn't be connected after multiple attempts",
          dispositions: [
            { name: 'Voicemail or IVR Detected', count: dispMap['VOICEMAIL'] || 0 },
            { name: 'No Response (Silence)', count: dispMap['NO_RESPONSE'] || 0 },
            { name: 'Not Connected (No Answer)', count: dispMap['NO_ANSWER'] || 0 },
            { name: 'Not Connected (Failed)', count: dispMap['FAILED'] || 0 },
            { name: 'Not Reached (Max attempts)', count: dispMap['NOT_REACHED'] || 0 },
          ],
        },
      ],
    };
  }

  /**
   * Validates and processes incoming LiveKit webhooks.
   */
  async processLiveKitWebhook(rawBody: Buffer | string, authHeader?: string) {
    if (!authHeader) {
      throw new AppError('Missing Authorization header in LiveKit webhook', 400);
    }

    const bodyString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
    const event = await this.webhookReceiver.receive(bodyString, authHeader);
    logger.info({ event: event.event, room: event.room?.name }, 'Received verified LiveKit webhook');

    const roomName = event.room?.name;
    if (!roomName) {
      return { handled: false, reason: 'unrelated_room' };
    }

    const p: any = event.participant;
    const sip = isSipParticipant(p);

    let callId: string | null = null;
    const isInbound = roomName.startsWith('inbound-');

    if (isInbound) {
      const existing = await query('SELECT id FROM calls WHERE room_name = $1', [roomName]);
      if (existing.rows.length > 0) {
        callId = existing.rows[0].id;
      } else if (event.event === 'participant_joined' && sip) {
        // Only register once the real caller is known; room_started / agent-joined events carry no number.
        const attrs = p?.attributes || {};
        const inbound = await this.registerInboundCall({
          roomName,
          phone: attrs['sip.phoneNumber'] || extractPhone(p?.identity),
          sipCallId: attrs['sip.callID'] || undefined,
        });
        callId = inbound.call.id;
      } else {
        // The agent registers the call itself; nothing to update yet.
        return { handled: false, reason: 'inbound_call_not_registered_yet' };
      }
    } else if (roomName.startsWith('call-')) {
      callId = roomName.replace('call-', '');
    } else {
      return { handled: false, reason: 'unrelated_room' };
    }

    if (event.event === 'participant_joined') {
      if (sip) {
        logger.info({ callId, participant: p?.identity }, 'Customer phone joined LiveKit room via SIP');
        await query(
          `UPDATE calls
           SET status = 'answered',
               call_status = 'answered',
               answered_at = COALESCE(answered_at, NOW())
           WHERE id = $1 AND status IN ('initiated', 'dialing')`,
          [callId]
        );
      }
    } else if ((event.event === 'participant_left' && sip) || event.event === 'room_finished') {
      // Only the phone leg ends the call (the agent leaving is not the customer hanging up)
      logger.info({ callId, event: event.event }, 'Call ended via webhook');
      await query(
        `UPDATE calls
         SET status = CASE WHEN status = 'answered' THEN 'completed' ELSE status END,
             duration_seconds = CASE WHEN (duration_seconds IS NULL OR duration_seconds = 0) AND answered_at IS NOT NULL THEN GREATEST(1, ROUND(EXTRACT(EPOCH FROM (NOW() - answered_at)))::int) ELSE duration_seconds END,
             ended_at = COALESCE(ended_at, NOW())
         WHERE id = $1`,
        [callId]
      );
    }

    return { handled: true, event: event.event };
  }

  /**
   * Sweeper: Resolves calls stuck in 'initiated' or 'dialing' older than 3 minutes.
   */
  async sweepStuckCalls() {
    const res = await query(
      `UPDATE calls
       SET status = 'NO_ANSWER',
           call_status = 'NO_ANSWER',
           failure_reason = 'Dialing timeout: callee did not answer within timeout period',
           ended_at = NOW()
       WHERE status IN ('initiated', 'dialing')
         AND COALESCE(direction, 'outbound') = 'outbound'
         AND created_at < NOW() - INTERVAL '3 minutes'
       RETURNING id, customer_id, room_name, created_at`
    );

    if (res.rows.length > 0) {
      logger.warn({ sweptCount: res.rows.length, sweptCalls: res.rows }, 'Sweeper resolved stuck calls to NO_ANSWER');
      for (const row of res.rows) {
        if (row.customer_id) await this.evaluateRetry(row.customer_id, 'NO_ANSWER', null);
      }
    }
  }

  /**
   * Fetches a call with customer details and outcome.
   */
  async getCall(callId: string) {
    const res = await query(
      `SELECT c.*,
              COALESCE(cust.name, rl.owner_name) as customer_name,
              COALESCE(cust.phone, rl.phone) as customer_phone,
              cust.address as customer_address,
              cust.account_no, cust.subs_del_no, cust.service_end_date, cust.total_attempts,
              camp.id as campaign_id, camp.name as campaign_name,
              COALESCE(co.outcome, ro.final_disposition) as outcome,
              COALESCE(co.final_disposition, ro.final_disposition) as final_disposition,
              co.pickup_date, co.confirmed_date,
              co.address_confirmed, co.new_address,
              COALESCE(co.transcript, ro.transcript) as transcript,
              COALESCE(co.customer_note, ro.agent_summary) as customer_note,
              rp.category as re_category, rp.intent as re_intent,
              rp.project_or_society as re_project_or_society, rp.sector_or_location as re_sector_or_location,
              rp.unit_number as re_unit_number, rp.floor_number as re_floor_number,
              rp.bhk_config as re_bhk_config, rp.commercial_type as re_commercial_type,
              rp.approx_area_sqft as re_approx_area_sqft, rp.furnishing_status as re_furnishing_status,
              rp.expected_sale_price as re_expected_sale_price, rp.expected_monthly_rent as re_expected_monthly_rent,
              rp.is_currently_leased as re_is_currently_leased, rp.current_rent_received as re_current_rent_received,
              rp.immediate_occupancy as re_immediate_occupancy
       FROM calls c
       LEFT JOIN customers cust ON c.customer_id = cust.id
       LEFT JOIN real_estate_leads rl ON c.re_lead_id = rl.id
       LEFT JOIN campaigns camp ON c.campaign_id = camp.id
       LEFT JOIN call_outcomes co ON c.id = co.call_id
       LEFT JOIN real_estate_outcomes ro ON c.id = ro.call_id
       LEFT JOIN real_estate_properties rp ON ro.property_id = rp.id
       WHERE c.id = $1`,
      [callId]
    );

    if (res.rows.length === 0) {
      throw new AppError(`Call not found: ${callId}`, 404);
    }

    const row = res.rows[0];
    return {
      ...row,
      final_disposition: matchCanonicalDisposition(
        row.final_disposition || row.call_status || row.status,
        row.duration_seconds,
        row.status
      ),
    };
  }

  async listCustomers(limit = 100) {
    const res = await query(`SELECT * FROM customers ORDER BY created_at DESC LIMIT $1`, [limit]);
    return res.rows.map((r: any) => serializeCustomer(r));
  }

  async listRecentCalls(limit = 100, status?: string, isTest?: boolean) {
    let q = `
      SELECT c.*,
              COALESCE(cust.name, rl.owner_name) as customer_name,
              COALESCE(cust.phone, rl.phone) as customer_phone,
              cust.subs_del_no,
              COALESCE(cust.language, rl.preferred_language) as customer_language,
              camp.id as campaign_id, camp.name as campaign_name,
              COALESCE(co.final_disposition, ro.final_disposition) as final_disposition,
              co.confirmed_date, co.pickup_date,
              COALESCE(co.transcript, ro.transcript) as transcript
       FROM calls c
       LEFT JOIN customers cust ON c.customer_id = cust.id
       LEFT JOIN real_estate_leads rl ON c.re_lead_id = rl.id
       LEFT JOIN campaigns camp ON c.campaign_id = camp.id
       LEFT JOIN call_outcomes co ON c.id = co.call_id
       LEFT JOIN real_estate_outcomes ro ON c.id = ro.call_id
    `;
    const params: any[] = [];
    const whereConditions: string[] = [];

    if (isTest) {
      whereConditions.push('c.is_test_call = TRUE');
    }

    if (status && status !== 'ALL') {
      const s = status.toUpperCase();
      if (s === 'SUCCESSFUL') {
        whereConditions.push(`(UPPER(c.status) IN ('COMPLETED', 'ANSWERED', 'SUCCESSFUL'))`);
      } else if (s === 'FAILED') {
        whereConditions.push(`(UPPER(c.status) IN ('FAILED', 'BUSY', 'DISCONNECTED'))`);
      } else if (s === 'NO_ANSWER' || s === 'NO ANSWER') {
        whereConditions.push(`(UPPER(c.status) IN ('NO_ANSWER', 'NO ANSWER', 'NO_RESPONSE', 'VOICEMAIL'))`);
      }
    }

    if (whereConditions.length > 0) {
      q += ` WHERE ${whereConditions.join(' AND ')}`;
    }

    q += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await query(q, params);
    return res.rows.map((row: any) => ({
      ...row,
      final_disposition: matchCanonicalDisposition(
        row.final_disposition || row.call_status || row.status,
        row.duration_seconds,
        row.status
      ),
    }));
  }
}

export const callService = new CallService();