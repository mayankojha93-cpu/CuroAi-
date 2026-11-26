import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
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
import { matchRealEstateDisposition } from '../utils/realEstateDispositions.js';
import { romanizeTranscript } from '../utils/transliteration.js';
import { getRecordingsDir } from './recordingDownloader.js';
import { realEstateCallService } from './realEstateCallService.js';
import { initiateExotelWssCall, fetchExotelCallDetails } from './exotelService.js';

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
  language?: string | null;
  initial_language?: string | null;
  language_switched?: boolean | null;
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

function extractPhone(value?: string | null): string {
  if (!value) return '';
  return value.replace(/^(phone-|sip_|sip:)/i, '').trim();
}

/** appendTurn() inserts a placeholder outcome ('In Progress'); that is NOT a real outcome. */
const hasFinalOutcome = (d?: string | null): boolean =>
  Boolean(d) && String(d).trim().toLowerCase() !== 'in progress';

export class CallService {
  constructor() {}

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

      let campaignTts = 'sarvam';
      if (customer.campaign_id) {
        const campRes = await client.query('SELECT tts_provider FROM campaigns WHERE id = $1', [customer.campaign_id]);
        if (campRes.rows[0]?.tts_provider) {
          campaignTts = String(campRes.rows[0].tts_provider).toLowerCase();
        }
      }

      const insertRes = await client.query(
        `INSERT INTO calls (id, customer_id, campaign_id, status, call_status, attempt_number, room_name, direction, language, initial_language, language_switched, tts_provider)
         VALUES ($1, $2, $3, 'initiated', 'initiated', $4, $5, 'outbound', $6, $6, FALSE, $7)
         RETURNING *`,
        [callId, customerId, customer.campaign_id || null, currentAttempt, roomName, customer.language || 'hi', campaignTts]
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
    tts_provider?: string;
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

    const rawLang = (data.language || 'hi').trim().toLowerCase();
    const cleanLang = (rawLang === 'en' || rawLang === 'english' || rawLang.startsWith('en-')) ? 'en' : 'hi';

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
        cleanLang,
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
    const ttsProvider = (data.tts_provider || 'sarvam').toLowerCase();
    const companyName = data.company_name || (data.script?.includes('Trump') ? 'Trump Towers India' : (data.script?.includes('Ratnafin') ? 'Ratnafin' : 'Airtel'));

    await query(
      `UPDATE calls 
       SET script = $1, company_name = $2, voice_pipeline = $3, tts_provider = $6, is_test_call = TRUE,
           language = $5, initial_language = $5, language_switched = FALSE 
       WHERE id = $4`,
      [scriptName, companyName, voicePipeline, call.id, cleanLang, ttsProvider]
    );

    call.script = scriptName;
    call.company_name = companyName;
    call.voice_pipeline = voicePipeline;
    (call as any).tts_provider = ttsProvider;
    call.is_test_call = true;
    (call as any).language = cleanLang;
    (call as any).initial_language = cleanLang;
    (call as any).language_switched = false;

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
   * Inserts or retrieves the call row, and links to the customer if known.
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
   * Internal workflow: Dials customer via Exotel WSS bidirectional audio stream to Pipecat agent.
   */
  private async executeOutboundCallWorkflow(
    callId: string,
    customer: any,
    roomName: string,
    _attemptNumber: number
  ) {
    try {
      const dialablePhone = normalizePhone(customer.phone, customer.subs_del_no);
      let callerId = env.SIP_CALLER_ID || env.EXOTEL_CALLER_ID || undefined;
      if (callerId && callerId.startsWith('+91') && callerId.length === 13) {
        callerId = `0${callerId.slice(3)}`;
      }

      await query("UPDATE calls SET status = 'dialing', call_status = 'dialing' WHERE id = $1", [callId]);

      let streamBase = env.EXOTEL_STREAM_URL || '';
      if (!streamBase) {
        if (env.PUBLIC_WEBHOOK_URL) {
          streamBase = env.PUBLIC_WEBHOOK_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
        } else {
          streamBase = 'wss://zoo-gig-voluntary-marina.trycloudflare.com';
        }
      }
      streamBase = streamBase.replace(/\/+$/, '');
      const streamUrl = `${streamBase}/api/exotel/media-stream/${encodeURIComponent(callId)}?callId=${encodeURIComponent(callId)}&phone=${encodeURIComponent(dialablePhone)}&pipeline=telecom&sample-rate=16000`;

      logger.info(
        { callId, roomName, phone: dialablePhone, callerId, customer: customer.name, streamUrl },
        `📞 [DIALING CARRIER] Dials: ${dialablePhone} via Exotel WSS Audio Stream to Pipecat Airtel Agent`
      );

      const exotelCall = await initiateExotelWssCall({
        callId,
        phone: dialablePhone,
        callerId,
        streamUrl,
      });

      await query(`UPDATE calls SET exotel_call_sid = $1, sip_call_id = $2 WHERE id = $3`, [
        exotelCall.sid,
        exotelCall.sid,
        callId,
      ]);

      logger.info(
        { callId, exotelCallSid: exotelCall.sid, phone: dialablePhone },
        `📞 [RINGING] Exotel WSS carrier accepted call leg | Call SID: ${exotelCall.sid}`
      );
    } catch (err: any) {
      let mappedStatus: 'NO_ANSWER' | 'BUSY' | 'FAILED' = 'FAILED';
      const failureReason = err.message || 'Call placement failed';

      if (err.message && err.message.toLowerCase().includes('timeout')) {
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
   * Incrementally appends a dialogue turn to PostgreSQL in real time.
   * Eliminates data loss if the agent crashes, process is terminated, or network drops.
   */
  async appendTurn(callId: string, turn: { role: string; text: string; timestamp?: string }) {
    const cleanText = (turn.text || '').trim();
    if (!cleanText) return;
    const role = turn.role === 'customer' || turn.role === 'user' ? 'customer' : 'assistant';
    const turnObj = {
      role,
      text: cleanText,
      timestamp: turn.timestamp || new Date().toISOString(),
    };

    logger.info(
      { callId, role, text: cleanText },
      `💬 [DIALOGUE] [${role === 'assistant' ? '🤖 Priya' : '🗣️ Customer'}]: "${cleanText}"`
    );

    // 1. Atomic JSONB append to calls table and mark answered
    await query(
      `UPDATE calls
       SET transcript = COALESCE(transcript, '[]'::jsonb) || $1::jsonb,
           status = CASE WHEN status IN ('initiated', 'dialing') THEN 'answered' ELSE status END,
           call_status = CASE WHEN call_status IN ('initiated', 'dialing') THEN 'answered' ELSE call_status END,
           answered_at = COALESCE(answered_at, NOW())
       WHERE id = $2`,
      [JSON.stringify([turnObj]), callId]
    );

    // 2. Also ensure call_outcomes records the turn incrementally
    await query(
      `INSERT INTO call_outcomes (
         call_id, outcome, final_disposition, transcript
       )
       VALUES ($1, 'no_response', 'In Progress', $2::jsonb)
       ON CONFLICT (call_id)
       DO UPDATE SET
         transcript = COALESCE(call_outcomes.transcript, '[]'::jsonb) || $2::jsonb`,
      [callId, JSON.stringify([turnObj])]
    );
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

    const processedTranscript = data.transcript ? romanizeTranscript(data.transcript) : null;
    const transcriptJson = processedTranscript ? JSON.stringify(processedTranscript) : null;
    const baseOutcome = data.outcome || finalDisp.toLowerCase();

    // Log the complete conversation in backend console
    if (processedTranscript && Array.isArray(processedTranscript) && processedTranscript.length > 0) {
      console.log(`\n======================================================================`);
      console.log(`  📞 AIRTEL CALL TRANSCRIPT (Call ID: ${callId})`);
      console.log(`  Disposition: ${finalDisp}`);
      console.log(`----------------------------------------------------------------------`);
      for (const turn of processedTranscript) {
        const isAgent = turn.role === 'assistant' || turn.role === 'agent';
        const speaker = isAgent ? '🤖 Priya   ' : '🗣️ Customer';
        const text = turn.text || turn.message || turn.content || '';
        console.log(`  ${speaker}: ${text}`);
      }
      console.log(`======================================================================\n`);
    }

    const outcomeRes = await query(
      `INSERT INTO call_outcomes (
         call_id, outcome, pickup_date, address_confirmed, corrected_address, transcript,
         identity_confirmed, pickup_accepted, proposed_date, confirmed_date,
         registered_address_confirmed, new_address, alternate_phone,
         final_disposition, customer_note, escalation_required, transcript_reference,
         language, initial_language, language_switched
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
         transcript_reference = EXCLUDED.transcript_reference,
         language = COALESCE(EXCLUDED.language, call_outcomes.language),
         initial_language = COALESCE(EXCLUDED.initial_language, call_outcomes.initial_language),
         language_switched = COALESCE(EXCLUDED.language_switched, call_outcomes.language_switched)
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
        data.language || null,
        data.initial_language || null,
        data.language_switched ?? null,
      ]
    );

    const duration = data.duration_seconds || 0;
    const medianLatency = data.median_latency_ms || null;
    const costEstimate = data.cost_estimate_inr || (duration > 0 ? (duration / 60) * 2.4 : 0.04);

    // Map into the 3 standard statuses: 'completed' (Successful), 'failed' (Failed), 'no_answer' (No Answer)
    let mappedStatus = 'completed';
    if (finalDisp === 'Not Connected (No Answer)') {
      mappedStatus = 'no_answer';
    } else if (finalDisp === 'Voicemail or IVR Detected') {
      mappedStatus = 'completed';
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
           recording_download_status = CASE WHEN $6 IS NOT NULL THEN 'done' ELSE recording_download_status END,
           recording_duration_seconds = COALESCE(recording_duration_seconds, $3),
           answered_at = COALESCE(answered_at, CASE WHEN $3 > 0 THEN NOW() - ($3 || ' seconds')::interval ELSE NOW() END),
           ended_at = COALESCE(ended_at, NOW()),
           language = COALESCE($8, language),
           initial_language = COALESCE($9, initial_language),
           language_switched = COALESCE($10, language_switched)
       WHERE id = $7`,
      [
        mappedStatus,
        finalDisp,
        duration,
        medianLatency,
        costEstimate,
        data.recording_url || null,
        callId,
        data.language || null,
        data.initial_language || null,
        data.language_switched ?? null,
      ]
    );

    if (call.customer_id && data.language) {
      await query(`UPDATE customers SET language = $1 WHERE id = $2`, [data.language, call.customer_id]);
    }

    // Update campaign counters if call is associated with a campaign
    if (call.campaign_id) {
      if (mappedStatus === 'completed') {
        await query(
          `UPDATE campaigns
           SET successful_calls = successful_calls + 1,
               remaining_calls = GREATEST(0, remaining_calls - 1),
               unique_called = (SELECT COUNT(DISTINCT COALESCE(re_lead_id::text, customer_id::text, id::text)) FROM calls WHERE campaign_id = $1),
               progress_percent = LEAST(100, ROUND(((SELECT COUNT(DISTINCT COALESCE(re_lead_id::text, customer_id::text, id::text)) FROM calls WHERE campaign_id = $1)::numeric / GREATEST(total_contacts, 1)::numeric) * 100)),
               updated_at = NOW()
           WHERE id = $1`,
          [call.campaign_id]
        );
      } else if (mappedStatus === 'failed') {
        await query(
          `UPDATE campaigns
           SET failed_calls = failed_calls + 1,
               remaining_calls = GREATEST(0, remaining_calls - 1),
               unique_called = (SELECT COUNT(DISTINCT COALESCE(re_lead_id::text, customer_id::text, id::text)) FROM calls WHERE campaign_id = $1),
               progress_percent = LEAST(100, ROUND(((SELECT COUNT(DISTINCT COALESCE(re_lead_id::text, customer_id::text, id::text)) FROM calls WHERE campaign_id = $1)::numeric / GREATEST(total_contacts, 1)::numeric) * 100)),
               updated_at = NOW()
           WHERE id = $1`,
          [call.campaign_id]
        );
      } else {
        await query(
          `UPDATE campaigns
           SET unique_called = (SELECT COUNT(DISTINCT COALESCE(re_lead_id::text, customer_id::text, id::text)) FROM calls WHERE campaign_id = $1),
               progress_percent = LEAST(100, ROUND(((SELECT COUNT(DISTINCT COALESCE(re_lead_id::text, customer_id::text, id::text)) FROM calls WHERE campaign_id = $1)::numeric / GREATEST(total_contacts, 1)::numeric) * 100)),
               updated_at = NOW()
           WHERE id = $1`,
          [call.campaign_id]
        );
      }

      // Immediately trigger next available campaign slot if campaign is active
      const campId = call.campaign_id;
      setTimeout(async () => {
        try {
          const campRes = await query(`SELECT status FROM campaigns WHERE id = $1`, [campId]);
          if (campRes.rows[0]?.status === 'RUNNING') {
            const { campaignService } = await import('./campaignService.js');
            await campaignService.startCampaign(campId, false);
          }
        } catch (_) {}
      }, 500);
    }

    if (call.customer_id) {
      await this.evaluateRetry(call.customer_id, finalDisp, data.confirmed_date || null);
    }

    return outcomeRes.rows[0];
  }

  /**
   * Fetches pending customers for retries.
   */
  async getPendingRetries(limit = 50, pipeline?: string) {
    if (pipeline === 'real_estate') {
      const res = await query(
        `SELECT id, owner_name as name, phone, preferred_language as language, total_attempts, max_attempts, next_attempt_time, notes, current_disposition
         FROM real_estate_leads
         WHERE total_attempts < max_attempts
           AND (lead_status = 'CALLBACK' OR next_attempt_time <= NOW() OR lead_status = 'NEW')
         ORDER BY next_attempt_time ASC NULLS FIRST
         LIMIT $1`,
        [limit]
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        address: r.notes || 'Property Owner Record',
        language: r.language,
        total_attempts: r.total_attempts,
        max_attempts: r.max_attempts,
        next_attempt_time: r.next_attempt_time,
        current_disposition: r.current_disposition,
        is_closed: false,
      }));
    }

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
   * Generates the campaign summary: "Airtel IP TV Urgent Campaign Summary" or "Real Estate Intake Summary"
   */
  async getCampaignSummary(pipeline?: string) {
    if (pipeline === 'real_estate') {
      const leadsRes = await query('SELECT COUNT(*) as count, COUNT(DISTINCT phone) as unique_contacts FROM real_estate_leads');
      const callsRes = await query(
        `SELECT COUNT(*) as attempts,
                COUNT(*) FILTER (WHERE status IN ('answered', 'completed', 'COMPLETED')) as connected
         FROM calls
         WHERE pipeline = 'real_estate' OR re_lead_id IS NOT NULL`
      );
      const dispRes = await query(`
        SELECT final_disposition, COUNT(*) as count
        FROM real_estate_outcomes
        GROUP BY final_disposition
      `);
      const dispMap: Record<string, number> = {};
      for (const r of dispRes.rows) {
        dispMap[r.final_disposition] = parseInt(r.count, 10);
      }
      const sourceRows = parseInt(leadsRes.rows[0]?.count || '0', 10);
      const uniqueContacts = parseInt(leadsRes.rows[0]?.unique_contacts || '0', 10);
      const connectedCalls = parseInt(callsRes.rows[0]?.connected || '0', 10);
      const totalAttempts = parseInt(callsRes.rows[0]?.attempts || '0', 10);
      const dispositionedContacts = Object.values(dispMap).reduce((a, b) => a + b, 0);

      return {
        overview: { sourceRows, uniqueContacts, connectedCalls, totalAttempts, dispositionedContacts },
        categories: [
          {
            category: 'Qualified & Actionable Leads',
            dispositions: [
              { name: 'Qualified Lead', count: dispMap['Qualified Lead'] || 0 },
              { name: 'Advisor Callback Booked', count: dispMap['Advisor Callback Booked'] || 0 },
              { name: 'Schedule Callback', count: dispMap['Schedule Callback'] || 0 },
              { name: 'WhatsApp Info Requested', count: dispMap['WhatsApp Info Requested'] || 0 },
            ],
          },
          {
            category: 'Non-Actionable & Suppression',
            dispositions: [
              { name: 'Not Interested', count: dispMap['Not Interested'] || 0 },
              { name: 'Do Not Call', count: dispMap['Do Not Call'] || 0 },
              { name: 'Wrong Number', count: dispMap['Wrong Number'] || 0 },
              { name: 'Not Connected (No Answer)', count: dispMap['Not Connected (No Answer)'] || 0 },
              { name: 'Abruptly Disconnected Call', count: dispMap['Abruptly Disconnected Call'] || 0 },
            ],
          },
        ],
      };
    }

    const totalCustomersRes = await query('SELECT COUNT(*) as count, COUNT(DISTINCT phone) as unique_contacts FROM customers');
    const totalCallsRes = await query(
      `SELECT COUNT(*) as attempts,
              COUNT(*) FILTER (WHERE status IN ('answered', 'completed', 'COMPLETED')) as connected
       FROM calls
       WHERE COALESCE(pipeline, 'airtel') = 'airtel' AND re_lead_id IS NULL`
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
            { name: 'Voicemail or IVR Detected', count: (dispMap['Voicemail or IVR Detected'] || 0) + (dispMap['VOICEMAIL'] || 0) + (dispMap['IVR'] || 0) },
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
   * Reconciler: Inspects in-flight calls against telephony carrier status and timeouts.
   * - Queries Exotel REST API to get authoritative carrier call status.
   * - If dialing older than ringing timeout (65s) and unanswered: marks as no_answer.
   * - If answered and completed by carrier or duration elapsed: marks as completed with duration and recording.
   * - Recovers missing outcomes, recordings, and transcripts.
   */
  async reconcileStuckCalls() {
    // 1. Fetch all calls currently in progress older than 30 seconds
    const inFlight = await query(
      `SELECT c.id, c.status, c.call_status, c.room_name, c.created_at, c.answered_at,
              c.duration_seconds, c.pipeline, c.re_lead_id, c.customer_id, c.exotel_call_sid,
              c.transcript as call_transcript,
              ro.final_disposition as re_disposition,
              ro.transcript as re_transcript
       FROM calls c
       LEFT JOIN real_estate_outcomes ro ON ro.call_id = c.id
       WHERE c.status IN ('initiated', 'dialing', 'answered')
         AND c.ended_at IS NULL
         AND c.created_at < NOW() - INTERVAL '30 seconds'`
    );

    if (inFlight.rows.length === 0) return;

    for (const call of inFlight.rows) {
      const ageSeconds = Math.round((Date.now() - new Date(call.created_at).getTime()) / 1000);

      // Check Exotel carrier status if call SID is available
      let exotelDetails: { recordingUrl?: string; duration?: number; status?: string } = {};
      if (call.exotel_call_sid) {
        try {
          exotelDetails = await fetchExotelCallDetails(call.exotel_call_sid);
        } catch (e: any) {
          logger.debug({ callId: call.id, err: e?.message }, 'Reconciler could not fetch Exotel call details');
        }
      }

      const carrierStatus = (exotelDetails.status || '').toLowerCase();

      // If call is still dialing / ringing:
      if (call.status === 'initiated' || call.status === 'dialing') {
        if (carrierStatus === 'in-progress' && ageSeconds < 65) {
          // Still ringing within normal ringing timeout
          continue;
        }

        if (carrierStatus === 'busy') {
          await query(
            `UPDATE calls SET status = 'busy', call_status = 'busy', ended_at = NOW() WHERE id = $1`,
            [call.id]
          );
          if (call.pipeline === 'real_estate' && !hasFinalOutcome(call.re_disposition)) {
            await realEstateCallService.saveOutcome(call.id, {
              final_disposition: 'Line Busy',
              duration_seconds: 0,
              transcript: [],
            }).catch(() => {});
          }
          if (call.customer_id) {
            await this.evaluateRetry(call.customer_id, 'BUSY', null);
          }
          continue;
        }

        if (carrierStatus === 'failed' || carrierStatus === 'canceled' || carrierStatus === 'cancelled') {
          await query(
            `UPDATE calls SET status = 'failed', call_status = 'failed', ended_at = NOW() WHERE id = $1`,
            [call.id]
          );
          if (call.pipeline === 'real_estate' && !hasFinalOutcome(call.re_disposition)) {
            await realEstateCallService.saveOutcome(call.id, {
              final_disposition: 'Call Failed (Carrier Disconnect)',
              duration_seconds: 0,
              transcript: [],
            }).catch(() => {});
          }
          if (call.customer_id) {
            await this.evaluateRetry(call.customer_id, 'FAILED', null);
          }
          continue;
        }

        // Callee did not answer or carrier says no-answer, or ringing timed out (>65s)
        if (carrierStatus !== 'completed' && (carrierStatus === 'no-answer' || ageSeconds >= 65)) {
          await query(
            `UPDATE calls
             SET status = 'no_answer',
                 call_status = 'no_answer',
                 failure_reason = 'Dialing timeout: callee did not answer within timeout period',
                 ended_at = NOW()
             WHERE id = $1`,
            [call.id]
          );

          if (call.pipeline === 'real_estate' && !hasFinalOutcome(call.re_disposition)) {
            try {
              await realEstateCallService.saveOutcome(call.id, {
                final_disposition: 'Not Connected (No Answer)',
                duration_seconds: 0,
                transcript: [],
              });
            } catch (e: any) {
              logger.warn({ callId: call.id, err: e?.message }, 'Reconciler saveOutcome no_answer warning');
            }
          }

          if (call.customer_id) {
            await this.evaluateRetry(call.customer_id, 'NO_ANSWER', null);
          }
          logger.info({ callId: call.id }, 'Reconciler resolved unanswered call to no_answer');
          continue;
        }
      }

      // If call is in 'answered' (or carrier reports completed):
      const isCarrierCompleted = carrierStatus === 'completed' || Boolean(exotelDetails.recordingUrl);
      const answeredAge = call.answered_at ? Math.round((Date.now() - new Date(call.answered_at).getTime()) / 1000) : ageSeconds;
      // The agent allows MAX_CALL_SECONDS (300) + 40s extension; finalizing earlier would end a LIVE call's record.
      const isDurationTimeout = answeredAge > Math.max(env.CALL_MAX_DURATION_SECONDS || 200, 340) + 60;

      if (!isCarrierCompleted && !isDurationTimeout) {
        // Call is actively in progress
        continue;
      }

      // Recover transcript if available
      let transcript = call.re_transcript || call.call_transcript || [];
      if (!Array.isArray(transcript) || transcript.length === 0) {
        try {
          const convDir = path.join(getRecordingsDir(), 'conversations');
          if (fs.existsSync(convDir)) {
            const files = fs.readdirSync(convDir);
            const matched = files.find((f: string) => f.includes(call.id));
            if (matched) {
              const content = fs.readFileSync(path.join(convDir, matched), 'utf-8');
              const parsedTurns: any[] = [];
              for (const line of content.split('\n')) {
                const turnM = line.match(/^\[\d{2}:\d{2}(?::\d{2})?\]\s*(🤖\s*Priya|🗣️\s*Customer)\s*:\s*(.+)$/);
                if (turnM) {
                  parsedTurns.push({
                    role: turnM[1].includes('Priya') ? 'assistant' : 'customer',
                    text: turnM[2].trim(),
                  });
                }
              }
              if (parsedTurns.length > 0) {
                transcript = parsedTurns;
              }
            }
          }
        } catch {}
      }

      // Recover recording URL
      let recoveredRecordingUrl: string | null = null;
      try {
        const recDir = getRecordingsDir();
        if (fs.existsSync(path.join(recDir, `${call.id}.mp3`)) || fs.existsSync(path.join(recDir, `${call.id}.wav`))) {
          recoveredRecordingUrl = `/api/calls/${call.id}/audio`;
        }
      } catch {}

      if (!recoveredRecordingUrl && exotelDetails.recordingUrl) {
        recoveredRecordingUrl = exotelDetails.recordingUrl;
      }

      const hasCustomerTurns = Array.isArray(transcript) && transcript.some((t: any) => t.role === 'customer' || t.role === 'user');
      const carrierTalkSeconds = carrierStatus === 'completed' ? (exotelDetails.duration || 0) : 0;
      const wasAnswered = Boolean(call.answered_at) || hasCustomerTurns || call.status === 'answered' || carrierTalkSeconds > 0;

      if (wasAnswered) {
        const startTime = call.answered_at ? new Date(call.answered_at).getTime() : new Date(call.created_at).getTime();
        const durationSec = exotelDetails.duration || Math.max(1, Math.round((Date.now() - startTime) / 1000));

        await query(
          `UPDATE calls
           SET status = 'completed',
               call_status = CASE WHEN call_status IN ('initiated', 'dialing') THEN 'completed' ELSE call_status END,
               duration_seconds = GREATEST($1, COALESCE(duration_seconds, 0)),
               recording_url = COALESCE(recording_url, $3),
               recording_download_status = CASE WHEN $3 IS NOT NULL THEN 'done' ELSE recording_download_status END,
               ended_at = NOW()
           WHERE id = $2`,
          [durationSec, call.id, recoveredRecordingUrl]
        );

        if (call.pipeline === 'real_estate' && !hasFinalOutcome(call.re_disposition)) {
          try {
            const hasDialogue = Array.isArray(transcript) && transcript.length > 0;
            const disp = hasDialogue ? 'Abruptly Disconnected Call' : 'Agent Not Connected (No Audio)';
            await realEstateCallService.saveOutcome(call.id, {
              final_disposition: disp,
              duration_seconds: durationSec,
              transcript: transcript,
              recording_url: recoveredRecordingUrl || undefined,
              failure_reason: hasDialogue ? undefined : 'Call answered but agent had not connected before disconnect',
            });
            logger.info({ callId: call.id, disposition: disp }, 'Reconciler finalized missing real estate outcome for ended call');
          } catch (e: any) {
            logger.warn({ callId: call.id, err: e?.message }, 'Reconciler saveOutcome warning');
          }
        }
      } else if (isCarrierCompleted) {
        // Carrier finished the call with no talk time and the agent never connected: resolve it, don't leave it stuck.
        await query(
          `UPDATE calls
           SET status = 'no_answer', call_status = 'no_answer',
               failure_reason = COALESCE(failure_reason, 'Carrier reported call ended with no connected audio'),
               ended_at = NOW()
           WHERE id = $1`,
          [call.id]
        );
        if (call.pipeline === 'real_estate' && !hasFinalOutcome(call.re_disposition)) {
          await realEstateCallService.saveOutcome(call.id, {
            final_disposition: 'Not Connected (No Answer)',
            duration_seconds: 0,
            transcript: [],
          }).catch((e: any) => logger.warn({ callId: call.id, err: e?.message }, 'Reconciler saveOutcome (carrier completed, no audio) warning'));
        }
        if (call.customer_id) {
          await this.evaluateRetry(call.customer_id, 'NO_ANSWER', null);
        }
      }
    }
  }

  /**
   * Sweeper alias for backwards compatibility
   */
  async sweepStuckCalls() {
    return this.reconcileStuckCalls();
  }

  /**
   * Fetches a call with customer details and outcome.
   */
  async getCall(callId: string, pipeline?: string) {
    const res = await query(
      `SELECT c.*,
              COALESCE(cust.name, rl.owner_name) as customer_name,
              COALESCE(cust.phone, rl.phone) as customer_phone,
              COALESCE(rl.property_location, cust.address) as customer_address,
              COALESCE(rl.property_location, cust.address) as property_location,
              cust.account_no, cust.subs_del_no, cust.service_end_date, cust.total_attempts,
              camp.id as campaign_id, camp.name as campaign_name,
              COALESCE(co.outcome, ro.final_disposition) as outcome,
              COALESCE(co.final_disposition, ro.final_disposition) as final_disposition,
              co.pickup_date, co.confirmed_date,
              co.address_confirmed, co.new_address,
              CASE
                WHEN ro.transcript IS NOT NULL AND jsonb_typeof(ro.transcript::jsonb) = 'array' AND jsonb_array_length(ro.transcript::jsonb) > 0 THEN ro.transcript
                WHEN co.transcript IS NOT NULL AND jsonb_typeof(co.transcript::jsonb) = 'array' AND jsonb_array_length(co.transcript::jsonb) > 0 THEN co.transcript
                WHEN c.transcript IS NOT NULL AND jsonb_typeof(c.transcript::jsonb) = 'array' AND jsonb_array_length(c.transcript::jsonb) > 0 THEN c.transcript
                ELSE COALESCE(ro.transcript, co.transcript, c.transcript, '[]'::jsonb)
              END as transcript,
              COALESCE(ro.agent_summary, co.customer_note) as customer_note,
              CASE
                WHEN (rp.commercial_type IS NOT NULL AND LOWER(rp.commercial_type) != 'residential')
                  OR LOWER(COALESCE(rp.category, '')) = 'commercial'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%office%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%shop%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%retail%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%showroom%'
                  OR LOWER(COALESCE(rp.sector_or_location, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%office%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%office%'
                  THEN 'commercial'
                WHEN rp.bhk_config IS NOT NULL
                  OR LOWER(COALESCE(rp.category, '')) = 'residential'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%bhk%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%flat%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%apartment%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%villa%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%bhk%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%flat%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%apartment%'
                  THEN 'residential'
                WHEN LOWER(COALESCE(rl.category, c.category, '')) = 'commercial' THEN 'commercial'
                WHEN LOWER(COALESCE(rl.category, c.category, '')) = 'residential' THEN 'residential'
                ELSE COALESCE(rl.category, c.category, NULL)
              END as re_category,
              rp.intent as re_intent,
              rp.project_or_society as re_project_or_society, rp.sector_or_location as re_sector_or_location,
              rp.unit_number as re_unit_number, rp.floor_number as re_floor_number,
              CASE
                WHEN (rp.commercial_type IS NOT NULL AND LOWER(rp.commercial_type) != 'residential')
                  OR LOWER(COALESCE(rp.category, '')) = 'commercial'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%office%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%shop%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%retail%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%showroom%'
                  OR LOWER(COALESCE(rp.sector_or_location, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%office%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%office%'
                  THEN NULL
                ELSE rp.bhk_config
              END as re_bhk_config,
              CASE
                WHEN rp.commercial_type IS NOT NULL AND LOWER(rp.commercial_type) != 'residential' THEN rp.commercial_type
                WHEN LOWER(COALESCE(rp.project_or_society, '')) LIKE '%office%' THEN 'Office Space'
                WHEN LOWER(COALESCE(rp.project_or_society, '')) LIKE '%shop%' THEN 'Retail Shop'
                WHEN LOWER(COALESCE(rp.project_or_society, '')) LIKE '%showroom%' THEN 'Showroom'
                WHEN LOWER(COALESCE(rp.category, '')) = 'commercial'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.sector_or_location, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%office%'
                  THEN 'Commercial Unit'
                ELSE NULL
              END as re_commercial_type,
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
       LEFT JOIN real_estate_properties rp ON (rp.id = COALESCE(ro.property_id, (SELECT id FROM real_estate_properties WHERE call_id = c.id LIMIT 1)))
       WHERE c.id = $1`,
      [callId]
    );

    if (res.rows.length === 0) {
      throw new AppError(`Call not found: ${callId}`, 404);
    }

    const row = res.rows[0];
    const isRealEstate = Boolean(
      row.re_lead_id ||
      (row.pipeline || '').toLowerCase() === 'real_estate' ||
      (row.script || '').toLowerCase().includes('estate') ||
      (row.script || '').toLowerCase().includes('sagar') ||
      (row.company_name || '').toLowerCase().includes('estate')
    );

    const callPipeline = isRealEstate ? 'real_estate' : 'airtel';
    if (pipeline && pipeline !== callPipeline) {
      throw new AppError('Unauthorized: You do not have permission to access calls from this pipeline', 403);
    }

    const finalDisp = isRealEstate
      ? matchRealEstateDisposition(row.final_disposition || row.call_status || row.status, row.duration_seconds, row.status, null, row.customer_note)
      : matchCanonicalDisposition(row.final_disposition || row.call_status || row.status, row.duration_seconds, row.status);

    let recUrl = row.recording_url;
    if (recUrl && (recUrl.includes('s3.') || recUrl.includes('amazonaws.com'))) {
      recUrl = `/api/calls/${row.id}/audio`;
    }
    if (!recUrl) {
      const storageDir = getRecordingsDir();
      const mp3Path = path.join(storageDir, `${row.id}.mp3`);
      const wavPath = path.join(storageDir, `${row.id}.wav`);
      const exotelPath = path.join(storageDir, `${row.id}-exotel.mp3`);
      const mp3Exists = fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 44;
      const wavExists = fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44;
      const exotelExists = fs.existsSync(exotelPath) && fs.statSync(exotelPath).size > 44;
      if (mp3Exists || wavExists || exotelExists) {
        recUrl = `/api/calls/${row.id}/audio`;
        query(`UPDATE calls SET recording_url = $1, recording_download_status = 'done' WHERE id = $2`, [recUrl, row.id]).catch(() => {});
      }
    }

    return {
      ...row,
      recording_url: recUrl,
      recording_download_status: recUrl ? 'done' : row.recording_download_status,
      transcript: romanizeTranscript(row.transcript),
      final_disposition: finalDisp,
    };
  }

  async listCustomers(limit = 100, pipeline?: string) {
    if (pipeline === 'real_estate') {
      const res = await query(
        `SELECT id, owner_name as name, phone, preferred_language as language, total_attempts, max_attempts, current_disposition, notes, created_at
         FROM real_estate_leads
         ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        address: r.notes || 'Property Owner',
        language: r.language,
        account_no: 'RE-LEAD',
        subs_del_no: 'OWNER',
        total_attempts: r.total_attempts,
        max_attempts: r.max_attempts,
        current_disposition: r.current_disposition,
        is_closed: false,
        created_at: r.created_at,
      }));
    }
    const res = await query(`SELECT * FROM customers ORDER BY created_at DESC LIMIT $1`, [limit]);
    return res.rows.map((r: any) => serializeCustomer(r));
  }

  async listRecentCalls(limit = 100, status?: string, isTest?: boolean, pipeline?: string) {
    let q = `
      SELECT c.*,
              COALESCE(cust.name, rl.owner_name) as customer_name,
              COALESCE(cust.phone, rl.phone) as customer_phone,
              cust.subs_del_no,
              COALESCE(c.language, cust.language, rl.preferred_language, 'hi') as customer_language,
              c.language as language,
              c.initial_language as initial_language,
              c.language_switched as language_switched,
              camp.id as campaign_id, camp.name as campaign_name,
              COALESCE(co.final_disposition, ro.final_disposition) as final_disposition,
              co.confirmed_date, co.pickup_date,
              COALESCE(ro.transcript, co.transcript, c.transcript) as transcript,
              COALESCE(ro.agent_summary, co.customer_note) as customer_note,
              CASE
                WHEN (rp.commercial_type IS NOT NULL AND LOWER(rp.commercial_type) != 'residential')
                  OR LOWER(COALESCE(rp.category, '')) = 'commercial'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%office%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%shop%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%retail%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%showroom%'
                  OR LOWER(COALESCE(rp.sector_or_location, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%office%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%office%'
                  THEN 'commercial'
                WHEN rp.bhk_config IS NOT NULL
                  OR LOWER(COALESCE(rp.category, '')) = 'residential'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%bhk%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%flat%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%apartment%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%villa%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%bhk%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%flat%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%apartment%'
                  THEN 'residential'
                WHEN LOWER(COALESCE(rl.category, c.category, '')) = 'commercial' THEN 'commercial'
                WHEN LOWER(COALESCE(rl.category, c.category, '')) = 'residential' THEN 'residential'
                ELSE COALESCE(rl.category, c.category, NULL)
              END as re_category,
              rp.intent as re_intent,
              rp.project_or_society as re_project_or_society, rp.sector_or_location as re_sector_or_location,
              rp.unit_number as re_unit_number, rp.floor_number as re_floor_number,
              CASE
                WHEN (rp.commercial_type IS NOT NULL AND LOWER(rp.commercial_type) != 'residential')
                  OR LOWER(COALESCE(rp.category, '')) = 'commercial'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%office%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%shop%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%retail%'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%showroom%'
                  OR LOWER(COALESCE(rp.sector_or_location, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%office%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%office%'
                  THEN NULL
                ELSE rp.bhk_config
              END as re_bhk_config,
              CASE
                WHEN rp.commercial_type IS NOT NULL AND LOWER(rp.commercial_type) != 'residential' THEN rp.commercial_type
                WHEN LOWER(COALESCE(rp.project_or_society, '')) LIKE '%office%' THEN 'Office Space'
                WHEN LOWER(COALESCE(rp.project_or_society, '')) LIKE '%shop%' THEN 'Retail Shop'
                WHEN LOWER(COALESCE(rp.project_or_society, '')) LIKE '%showroom%' THEN 'Showroom'
                WHEN LOWER(COALESCE(rp.category, '')) = 'commercial'
                  OR LOWER(COALESCE(rp.project_or_society, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.sector_or_location, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(rp.raw_notes, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%commercial%'
                  OR LOWER(COALESCE(ro.agent_summary, '')) LIKE '%office%'
                  THEN 'Commercial Unit'
                ELSE NULL
              END as re_commercial_type,
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
       LEFT JOIN real_estate_properties rp ON (rp.id = COALESCE(ro.property_id, (SELECT id FROM real_estate_properties WHERE call_id = c.id LIMIT 1)))
    `;
    const params: any[] = [];
    const whereConditions: string[] = [];

    // Pipeline isolation: strictly isolate calls between Airtel and Real Estate pipelines
    if (pipeline === 'real_estate') {
      whereConditions.push(`(
        c.pipeline = 'real_estate' OR
        c.re_lead_id IS NOT NULL OR
        LOWER(COALESCE(c.script, '')) LIKE '%estate%' OR
        LOWER(COALESCE(c.script, '')) LIKE '%sagar%' OR
        LOWER(COALESCE(c.company_name, '')) LIKE '%estate%'
      )`);
    } else if (pipeline === 'airtel') {
      whereConditions.push(`(
        COALESCE(c.pipeline, 'airtel') = 'airtel' AND
        c.re_lead_id IS NULL AND
        LOWER(COALESCE(c.script, '')) NOT LIKE '%estate%' AND
        LOWER(COALESCE(c.script, '')) NOT LIKE '%sagar%' AND
        LOWER(COALESCE(c.company_name, '')) NOT LIKE '%estate%'
      )`);
    }

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
    const storageDir = getRecordingsDir();
    return res.rows.map((row: any) => {
      let recUrl = row.recording_url;
      if (recUrl && (recUrl.includes('s3.') || recUrl.includes('amazonaws.com'))) {
        recUrl = `/api/calls/${row.id}/audio`;
      }
      if (!recUrl) {
        const mp3Path = path.join(storageDir, `${row.id}.mp3`);
        const wavPath = path.join(storageDir, `${row.id}.wav`);
        const exotelPath = path.join(storageDir, `${row.id}-exotel.mp3`);
        const mp3Exists = fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 44;
        const wavExists = fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44;
        const exotelExists = fs.existsSync(exotelPath) && fs.statSync(exotelPath).size > 44;
        if (mp3Exists || wavExists || exotelExists) {
          recUrl = `/api/calls/${row.id}/audio`;
          query(`UPDATE calls SET recording_url = $1, recording_download_status = 'done' WHERE id = $2`, [recUrl, row.id]).catch(() => {});
        }
      }

      const isRealEstate = Boolean(
        row.re_lead_id ||
        (row.script || '').toLowerCase().includes('estate') ||
        (row.script || '').toLowerCase().includes('sagar') ||
        (row.company_name || '').toLowerCase().includes('estate') ||
        (row.voice_pipeline || '').toLowerCase().includes('aditya')
      );

      const finalDisp = isRealEstate
        ? matchRealEstateDisposition(row.final_disposition || row.call_status || row.status, row.duration_seconds, row.status, null, row.customer_note)
        : matchCanonicalDisposition(row.final_disposition || row.call_status || row.status, row.duration_seconds, row.status);

      return {
        ...row,
        recording_url: recUrl,
        recording_download_status: recUrl ? 'done' : row.recording_download_status,
        final_disposition: finalDisp,
      };
    });
  }
}

export const callService = new CallService();