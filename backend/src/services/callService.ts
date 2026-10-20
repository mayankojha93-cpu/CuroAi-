import { randomUUID } from 'crypto';
import {
  LiveKitAPI,
  SipClient,
  AgentDispatchClient,
  RoomServiceClient,
  SipCallError,
  WebhookReceiver,
} from 'livekit-server-sdk';
import { pool, query } from '../db/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errorHandler.js';

export interface CallRecord {
  id: string;
  customer_id: string;
  status: 'initiated' | 'dialing' | 'answered' | 'completed' | 'no_answer' | 'busy' | 'failed';
  room_name: string;
  sip_call_id: string | null;
  failure_reason: string | null;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

export interface SaveOutcomeInput {
  outcome: 'pickup_scheduled' | 'pickup_declined' | 'wrong_person' | 'callback_requested' | 'escalated' | 'no_response';
  pickup_date?: string | null;
  address_confirmed?: boolean | null;
  corrected_address?: string | null;
  transcript?: any;
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
    // 1. Load customer
    const custRes = await query(
      'SELECT id, name, phone, address, language FROM customers WHERE id = $1',
      [customerId]
    );

    if (custRes.rows.length === 0) {
      throw new AppError(`Customer not found with ID: ${customerId}`, 404);
    }
    const customer = custRes.rows[0];

    // 2. Insert call record with 'initiated'
    const callId = randomUUID();
    const roomName = `call-${callId}`;

    logger.info({ customerId, callId, roomName, phone: customer.phone }, 'Initiating outbound call');

    const insertRes = await query<CallRecord>(
      `INSERT INTO calls (id, customer_id, status, room_name)
       VALUES ($1, $2, 'initiated', $3)
       RETURNING *`,
      [callId, customerId, roomName]
    );
    const call = insertRes.rows[0];

    // Perform dial asynchronously so the API responds quickly, while updating states
    this.executeOutboundCallWorkflow(callId, customer, roomName).catch((err) => {
      logger.error({ err, callId }, 'Unhandled error in outbound call workflow');
    });

    return call;
  }

  /**
   * Internal workflow: Creates room, dispatches agent, dials SIP participant, and handles dial results.
   */
  private async executeOutboundCallWorkflow(callId: string, customer: any, roomName: string) {
    try {
      // 1. Ensure room exists
      await this.roomService.createRoom({
        name: roomName,
        emptyTimeout: 300,
      });

      // 2. Create explicit agent dispatch
      logger.info({ roomName, agentName: env.AGENT_NAME }, 'Creating agent dispatch');
      await this.dispatchClient.createDispatch(roomName, env.AGENT_NAME, {
        metadata: JSON.stringify({
          callId,
          customerName: customer.name,
          address: customer.address,
          phone: customer.phone,
          preferredLanguage: customer.language,
        }),
      });

      // 3. Update call status to 'dialing'
      await query("UPDATE calls SET status = 'dialing' WHERE id = $1", [callId]);
      logger.info({ callId, phone: customer.phone }, 'Updated call status to dialing. Calling SIP trunk...');

      // 4. Dial SIP participant
      const participant = await this.sipClient.createSipParticipant(
        env.SIP_OUTBOUND_TRUNK_ID,
        customer.phone,
        roomName,
        {
          participantIdentity: `phone-${customer.phone.replace(/[^0-9]/g, '')}`,
          displayName: customer.name,
          fromNumber: env.SIP_CALLER_ID || undefined,
          waitUntilAnswered: true,
          ringingTimeout: 30,
        }
      );

      // 5. If answered successfully
      logger.info({ callId, sipCallId: participant.sipCallId }, 'SIP call answered by customer!');
      await query(
        `UPDATE calls 
         SET status = 'answered', 
             sip_call_id = $1, 
             answered_at = NOW() 
         WHERE id = $2`,
        [participant.sipCallId || null, callId]
      );

    } catch (err: any) {
      let mappedStatus: 'no_answer' | 'busy' | 'failed' = 'failed';
      let failureReason = err.message || 'Call placement failed';

      if (err instanceof SipCallError) {
        failureReason = `SIP ${err.sipStatusCode} (${err.sipStatus || 'Error'}): ${err.message}`;
        if (err.sipStatusCode === 486 || err.sipStatusCode === 600) {
          mappedStatus = 'busy';
        } else if (err.sipStatusCode === 408 || err.sipStatusCode === 480 || err.sipStatusCode === 487) {
          mappedStatus = 'no_answer';
        } else {
          mappedStatus = 'failed';
        }
      } else if (err.message && err.message.toLowerCase().includes('timeout')) {
        mappedStatus = 'no_answer';
      }

      logger.warn({ callId, mappedStatus, failureReason }, 'Outbound dial failed or rejected');

      await query(
        `UPDATE calls 
         SET status = $1, 
             failure_reason = $2, 
             ended_at = NOW() 
         WHERE id = $3`,
        [mappedStatus, failureReason, callId]
      );

      // Clean up empty room on failed dial
      try {
        await this.roomService.deleteRoom(roomName);
      } catch (_) {}
    }
  }

  /**
   * Idempotent save outcome handler.
   */
  async saveOutcome(callId: string, data: SaveOutcomeInput) {
    logger.info({ callId, outcome: data.outcome }, 'Saving call outcome (idempotent)');

    // Ensure call exists
    const callRes = await query('SELECT id, status FROM calls WHERE id = $1', [callId]);
    if (callRes.rows.length === 0) {
      throw new AppError(`Call not found: ${callId}`, 404);
    }

    const transcriptJson = data.transcript ? JSON.stringify(data.transcript) : null;

    // Idempotent upsert into call_outcomes
    const outcomeRes = await query(
      `INSERT INTO call_outcomes (call_id, outcome, pickup_date, address_confirmed, corrected_address, transcript)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (call_id)
       DO UPDATE SET 
         outcome = EXCLUDED.outcome,
         pickup_date = EXCLUDED.pickup_date,
         address_confirmed = EXCLUDED.address_confirmed,
         corrected_address = EXCLUDED.corrected_address,
         transcript = EXCLUDED.transcript
       RETURNING *`,
      [
        callId,
        data.outcome,
        data.pickup_date || null,
        data.address_confirmed ?? null,
        data.corrected_address || null,
        transcriptJson,
      ]
    );

    // Update call status to completed and set ended_at if not already ended
    await query(
      `UPDATE calls 
       SET status = CASE WHEN status IN ('answered', 'dialing', 'initiated') THEN 'completed' ELSE status END,
           ended_at = COALESCE(ended_at, NOW())
       WHERE id = $1`,
      [callId]
    );

    return outcomeRes.rows[0];
  }

  /**
   * Fetches a call with customer details and outcome.
   */
  async getCall(callId: string) {
    const res = await query(
      `SELECT c.*, 
              cust.name as customer_name, cust.phone as customer_phone, cust.address as customer_address,
              co.outcome, co.pickup_date, co.address_confirmed, co.corrected_address, co.transcript
       FROM calls c
       JOIN customers cust ON c.customer_id = cust.id
       LEFT JOIN call_outcomes co ON c.id = co.call_id
       WHERE c.id = $1`,
      [callId]
    );

    if (res.rows.length === 0) {
      throw new AppError(`Call not found: ${callId}`, 404);
    }

    return res.rows[0];
  }

  /**
   * Lists latest 20 calls.
   */
  async listRecentCalls(limit = 20) {
    const res = await query(
      `SELECT c.*, 
              cust.name as customer_name, cust.phone as customer_phone,
              co.outcome, co.pickup_date
       FROM calls c
       JOIN customers cust ON c.customer_id = cust.id
       LEFT JOIN call_outcomes co ON c.id = co.call_id
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [limit]
    );

    return res.rows;
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
    if (!roomName || !roomName.startsWith('call-')) {
      return { handled: false, reason: 'unrelated_room' };
    }

    const callId = roomName.replace('call-', '');

    if (event.event === 'participant_joined') {
      const p = event.participant;
      if (p?.identity?.startsWith('phone-') || p?.kind === 2 /* SIP */) {
        logger.info({ callId, participant: p.identity }, 'Customer phone joined LiveKit room via SIP');
        await query(
          `UPDATE calls 
           SET status = 'answered', 
               answered_at = COALESCE(answered_at, NOW()) 
           WHERE id = $1 AND status IN ('initiated', 'dialing')`,
          [callId]
        );
      }
    } else if (event.event === 'participant_left' || event.event === 'room_finished') {
      logger.info({ callId, event: event.event }, 'Call ended via webhook');
      await query(
        `UPDATE calls 
         SET status = CASE WHEN status = 'answered' THEN 'completed' ELSE status END,
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
       SET status = 'no_answer', 
           failure_reason = 'Dialing timeout: callee did not answer within timeout period',
           ended_at = NOW() 
       WHERE status IN ('initiated', 'dialing') 
         AND created_at < NOW() - INTERVAL '3 minutes'
       RETURNING id, room_name, created_at`
    );

    if (res.rows.length > 0) {
      logger.warn({ sweptCount: res.rows.length, sweptCalls: res.rows }, 'Sweeper resolved stuck calls to no_answer');
    }
  }
}

export const callService = new CallService();
