import { randomUUID } from 'crypto';
import { query } from '../db/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { normalizePhone } from '../utils/csvParser.js';
import { initiateExotelWssCall } from './exotelService.js';
import { deriveCallDisposition, deriveTripStatusFromOutcome } from '../utils/logisticsDispositions.js';

export interface LogisticsTripInput {
  driver_name: string;
  driver_phone: string;
  vehicle_number: string;
  lr_number: string;
  origin?: string;
  destination?: string;
  consignee?: string;
  material?: string;
  expected_unload_date?: string;
  current_call_round?: number;
  next_assignment?: string;
  plant_contact_number?: string;
  ops_number?: string;
  notes?: string;
  tts_provider?: string;
}

export interface SaveLogisticsOutcomeInput {
  trip_id?: string | null;
  call_status?: string;
  callback_time?: string;
  vehicle_number?: string;
  lr_number?: string;
  unloaded?: string;
  current_location?: string;
  unloading_delay_reason?: string;
  waiting_hours?: string;
  pod_signed_received?: string;
  shortage_or_damage_reported?: string;
  issue_details?: string;
  money_demanded_amount?: string;
  next_assignment_communicated?: string;
  driver_accepted_next_assignment?: string;
  driver_departure_eta?: string;
  priority?: string;
  escalate_to_human?: string;
  driver_questions_for_ops?: string;
  summary_in_english?: string;
  raw_json?: any;
  transcript?: any;
  duration_seconds?: number | null;
  median_latency_ms?: number | null;
  recording_url?: string | null;
  failure_reason?: string | null;
}

export class LogisticsCallService {
  async getTrips(filters?: { status?: string; limit?: number; offset?: number }) {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filters?.status && filters.status !== 'ALL') {
      conditions.push(`t.trip_status = $${idx++}`);
      params.push(filters.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters?.limit || 100, 500);
    const offset = filters?.offset || 0;

    const res = await query(
      `SELECT t.*,
              lo.call_status as last_call_status,
              lo.unloaded as last_unloaded,
              lo.unloading_delay_reason as last_delay_reason,
              lo.priority as last_priority,
              lo.escalate_to_human as last_escalate,
              lo.driver_departure_eta as last_departure_eta,
              lo.summary_in_english as last_summary
       FROM logistics_trips t
       LEFT JOIN LATERAL (
         SELECT call_status, unloaded, unloading_delay_reason, priority, escalate_to_human, driver_departure_eta, summary_in_english
         FROM logistics_call_outcomes
         WHERE trip_id = t.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lo ON TRUE
       ${whereClause}
       ORDER BY
         CASE WHEN lo.priority = 'urgent' THEN 0 WHEN lo.priority = 'high' THEN 1 ELSE 2 END,
         t.updated_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );
    return res.rows;
  }

  async createTrip(data: LogisticsTripInput) {
    const normalizedPhone = normalizePhone(data.driver_phone);
    if (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 10) {
      throw new AppError('A valid 10-digit driver phone number is required', 400);
    }

    const res = await query(
      `INSERT INTO logistics_trips (
         driver_name, driver_phone, vehicle_number, lr_number, origin, destination, consignee,
         material, expected_unload_date, current_call_round, next_assignment, plant_contact_number, ops_number, notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        data.driver_name.trim(),
        normalizedPhone,
        data.vehicle_number.trim().toUpperCase(),
        data.lr_number.trim(),
        data.origin?.trim() || null,
        data.destination?.trim() || null,
        data.consignee?.trim() || null,
        data.material?.trim() || 'Pigment powder bags / drums',
        data.expected_unload_date?.trim() || null,
        data.current_call_round === 2 ? 2 : 1,
        data.next_assignment?.trim() || null,
        data.plant_contact_number?.trim() || null,
        data.ops_number?.trim() || '9800011122',
        data.notes?.trim() || null,
      ]
    );
    return res.rows[0];
  }

  async importTrips(trips: LogisticsTripInput[]) {
    const created: any[] = [];
    for (const trip of trips) {
      const row = await this.createTrip(trip);
      created.push(row);
    }
    return created;
  }

  async initiateTestCall(data: LogisticsTripInput) {
    const trip = await this.createTrip(data);
    const { call } = await this.initiateCall(trip.id, trip.current_call_round, true, data.tts_provider);
    return { call, trip };
  }

  async initiateCall(tripId: string, callRoundOverride?: number, isTestCall = false, ttsProviderOverride?: string) {
    const tripRes = await query(`SELECT * FROM logistics_trips WHERE id = $1`, [tripId]);
    if (tripRes.rows.length === 0) {
      throw new AppError(`Logistics trip not found: ${tripId}`, 404);
    }
    const trip = tripRes.rows[0];

    // Concurrency guard
    const activeCheck = await query(
      `SELECT id, room_name FROM calls
       WHERE logistics_trip_id = $1
         AND status IN ('initiated', 'dialing', 'answered')
         AND created_at > NOW() - INTERVAL '10 minutes'
       LIMIT 1`,
      [tripId]
    );
    if (activeCheck.rows.length > 0) {
      logger.warn({ tripId, activeCallId: activeCheck.rows[0].id }, 'Trip already has an active call in progress');
      return { call: activeCheck.rows[0], trip };
    }

    const round = callRoundOverride === 2 ? 2 : callRoundOverride === 1 ? 1 : (trip.current_call_round || 1);
    const ttsProvider = (ttsProviderOverride || 'sarvam').toLowerCase();
    const callId = randomUUID();
    const roomName = `logistics-call-${callId}`;

    const insertCall = await query(
      `INSERT INTO calls (
         id, logistics_trip_id, status, call_status, attempt_number, room_name, direction,
         script, company_name, voice_pipeline, tts_provider, is_test_call, pipeline, language, initial_language, language_switched
       )
       VALUES ($1, $2, 'initiated', 'initiated', $3, $4, 'outbound',
               'Mittal Pigments Logistics Assistant', 'Mittal Pigments Private Limited',
               'Sarvam AI (hi/en)', $6, $5, 'logistics', 'hi', 'hi', FALSE)
       RETURNING *`,
      [callId, trip.id, round, roomName, isTestCall, ttsProvider]
    );
    const call = insertCall.rows[0];

    await query(
      `UPDATE logistics_trips SET current_call_round = $1, last_called_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [round, trip.id]
    );

    this.executeOutboundWorkflow(callId, trip).catch((err) => {
      logger.error({ err, callId }, 'Unhandled error in logistics outbound call workflow');
    });

    return { call, trip };
  }

  private async executeOutboundWorkflow(callId: string, trip: any) {
    try {
      await query(`UPDATE calls SET status = 'dialing', call_status = 'dialing' WHERE id = $1`, [callId]);

      let streamBase = env.EXOTEL_STREAM_URL || '';
      if (!streamBase && env.PUBLIC_WEBHOOK_URL) {
        streamBase = env.PUBLIC_WEBHOOK_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
      }
      if (!streamBase) {
        streamBase = 'wss://zoo-gig-voluntary-marina.trycloudflare.com';
      }
      streamBase = streamBase.replace(/\/+$/, '');

      const rawPhone = String(trip.driver_phone || '').replace(/[^0-9+]/g, '');
      let dialable = rawPhone;
      if (dialable.startsWith('+91') && dialable.length === 13) {
        dialable = `0${dialable.slice(3)}`;
      } else if (!dialable.startsWith('0') && !dialable.startsWith('+')) {
        dialable = `0${dialable}`;
      }

      const streamUrl = `${streamBase}/api/exotel/media-stream/${encodeURIComponent(callId)}?callId=${encodeURIComponent(callId)}&phone=${encodeURIComponent(dialable)}&pipeline=logistics&sample-rate=16000`;

      const exotelCall = await initiateExotelWssCall({
        callId,
        phone: dialable,
        streamUrl,
      });

      await query('UPDATE calls SET exotel_call_sid = $1, sip_call_id = $2 WHERE id = $3', [
        exotelCall.sid,
        exotelCall.sid,
        callId,
      ]);

      logger.info(
        { callId, exotelCallSid: exotelCall.sid, phone: dialable },
        `📞 [LOGISTICS-RINGING] Exotel WSS call placed | Call SID: ${exotelCall.sid}`
      );
    } catch (err: any) {
      const failureReason = err.message || 'Call placement failed';
      logger.warn({ callId, failureReason }, 'Logistics dial failed');
      await query(
        `UPDATE calls SET status = 'failed', call_status = 'failed', failure_reason = $1, ended_at = NOW() WHERE id = $2`,
        [failureReason, callId]
      );
    }
  }

  async appendTurn(callId: string, turn: { role?: string; text: string; timestamp?: string }) {
    const entry = JSON.stringify([
      {
        role: turn.role || 'assistant',
        text: turn.text,
        timestamp: turn.timestamp || new Date().toISOString(),
      },
    ]);
    await query(
      `UPDATE calls
       SET transcript = COALESCE(transcript, '[]'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [entry, callId]
    );
  }

  async saveOutcome(callId: string, input: SaveLogisticsOutcomeInput) {
    const callRes = await query(`SELECT * FROM calls WHERE id = $1`, [callId]);
    if (callRes.rows.length === 0) {
      throw new AppError(`Call not found: ${callId}`, 404);
    }
    const call = callRes.rows[0];
    const tripId = input.trip_id || call.logistics_trip_id || null;

    const callStatus = input.call_status || 'connected';
    const priority = input.priority || 'normal';
    const escalate = input.escalate_to_human || (priority === 'urgent' || priority === 'high' ? 'yes' : 'no');
    const disposition = deriveCallDisposition({
      call_status: callStatus,
      unloaded: input.unloaded,
      priority,
      escalate_to_human: escalate,
      unloading_delay_reason: input.unloading_delay_reason,
    });

    const outcomeRes = await query(
      `INSERT INTO logistics_call_outcomes (
         call_id, trip_id, call_status, callback_time, vehicle_number, lr_number,
         unloaded, current_location, unloading_delay_reason, waiting_hours,
         pod_signed_received, shortage_or_damage_reported, issue_details,
         money_demanded_amount, next_assignment_communicated, driver_accepted_next_assignment,
         driver_departure_eta, priority, escalate_to_human, driver_questions_for_ops,
         summary_in_english, raw_json, transcript, duration_seconds, median_latency_ms
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16,
         $17, $18, $19, $20,
         $21, $22::jsonb, $23::jsonb, $24, $25
       )
       ON CONFLICT (call_id) DO UPDATE SET
         call_status = EXCLUDED.call_status,
         callback_time = EXCLUDED.callback_time,
         unloaded = EXCLUDED.unloaded,
         current_location = EXCLUDED.current_location,
         unloading_delay_reason = EXCLUDED.unloading_delay_reason,
         waiting_hours = EXCLUDED.waiting_hours,
         pod_signed_received = EXCLUDED.pod_signed_received,
         shortage_or_damage_reported = EXCLUDED.shortage_or_damage_reported,
         issue_details = EXCLUDED.issue_details,
         money_demanded_amount = EXCLUDED.money_demanded_amount,
         next_assignment_communicated = EXCLUDED.next_assignment_communicated,
         driver_accepted_next_assignment = EXCLUDED.driver_accepted_next_assignment,
         driver_departure_eta = EXCLUDED.driver_departure_eta,
         priority = EXCLUDED.priority,
         escalate_to_human = EXCLUDED.escalate_to_human,
         driver_questions_for_ops = EXCLUDED.driver_questions_for_ops,
         summary_in_english = EXCLUDED.summary_in_english,
         raw_json = EXCLUDED.raw_json,
         transcript = EXCLUDED.transcript,
         duration_seconds = EXCLUDED.duration_seconds,
         median_latency_ms = EXCLUDED.median_latency_ms
       RETURNING *`,
      [
        callId,
        tripId,
        callStatus,
        input.callback_time || '',
        input.vehicle_number || '',
        input.lr_number || '',
        input.unloaded || 'unknown',
        input.current_location || '',
        input.unloading_delay_reason || 'none',
        input.waiting_hours || '',
        input.pod_signed_received || 'na',
        input.shortage_or_damage_reported || 'no',
        input.issue_details || '',
        input.money_demanded_amount || '',
        input.next_assignment_communicated || 'no',
        input.driver_accepted_next_assignment || 'no',
        input.driver_departure_eta || '',
        priority,
        escalate,
        input.driver_questions_for_ops || '',
        input.summary_in_english || '',
        JSON.stringify(input.raw_json || input),
        JSON.stringify(input.transcript || []),
        input.duration_seconds ?? null,
        input.median_latency_ms ?? null,
      ]
    );

    const finalStatus = callStatus === 'no_answer' ? 'no_answer' : 'completed';
    await query(
      `UPDATE calls
       SET status = $1,
           call_status = $1,
           outcome = $2,
           final_disposition = $2,
           transcript = COALESCE($3::jsonb, transcript),
           duration_seconds = COALESCE($4, duration_seconds),
           median_latency_ms = COALESCE($5, median_latency_ms),
           recording_url = COALESCE($6, recording_url),
           failure_reason = COALESCE($7, failure_reason),
           ended_at = COALESCE(ended_at, NOW())
       WHERE id = $8`,
      [
        finalStatus,
        disposition,
        input.transcript ? JSON.stringify(input.transcript) : null,
        input.duration_seconds ?? null,
        input.median_latency_ms ?? null,
        input.recording_url ?? null,
        input.failure_reason ?? null,
        callId,
      ]
    );

    if (tripId) {
      const nextTripStatus = deriveTripStatusFromOutcome({
        call_status: callStatus,
        unloaded: input.unloaded,
        priority,
        escalate_to_human: escalate,
      });
      await query(
        `UPDATE logistics_trips
         SET trip_status = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [nextTripStatus, tripId]
      );
    }

    return outcomeRes.rows[0];
  }

  async getCalls(limit = 50, offset = 0) {
    const res = await query(
      `SELECT c.*,
              t.driver_name, t.driver_phone, t.vehicle_number, t.lr_number,
              t.origin, t.destination, t.consignee, t.current_call_round,
              lo.call_status as logistics_call_status,
              lo.callback_time, lo.unloaded, lo.current_location,
              lo.unloading_delay_reason, lo.waiting_hours,
              lo.pod_signed_received, lo.shortage_or_damage_reported,
              lo.issue_details, lo.money_demanded_amount,
              lo.next_assignment_communicated, lo.driver_accepted_next_assignment,
              lo.driver_departure_eta, lo.priority, lo.escalate_to_human,
              lo.driver_questions_for_ops, lo.summary_in_english, lo.raw_json
       FROM calls c
       LEFT JOIN logistics_trips t ON c.logistics_trip_id = t.id
       LEFT JOIN logistics_call_outcomes lo ON lo.call_id = c.id
       WHERE c.pipeline = 'logistics'
       ORDER BY c.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.rows;
  }

  async getEscalations() {
    const res = await query(
      `SELECT lo.*, c.created_at as call_created_at, c.recording_url,
              t.driver_name, t.driver_phone, t.origin, t.destination, t.consignee, t.ops_number
       FROM logistics_call_outcomes lo
       JOIN calls c ON lo.call_id = c.id
       LEFT JOIN logistics_trips t ON lo.trip_id = t.id
       WHERE lo.escalate_to_human = 'yes' OR lo.priority IN ('high', 'urgent')
       ORDER BY
         CASE WHEN lo.priority = 'urgent' THEN 0 WHEN lo.priority = 'high' THEN 1 ELSE 2 END,
         lo.created_at DESC
       LIMIT 100`
    );
    return res.rows;
  }

  async getSummary() {
    const [tripStats, escStats] = await Promise.all([
      query(`
        SELECT
          COUNT(*)::int as total_trips,
          COUNT(*) FILTER (WHERE trip_status = 'UNLOADED')::int as unloaded_count,
          COUNT(*) FILTER (WHERE trip_status IN ('WAITING_UNLOAD', 'IN_TRANSIT'))::int as in_progress_count,
          COUNT(*) FILTER (WHERE trip_status = 'ESCALATED')::int as escalated_count,
          COUNT(*) FILTER (WHERE trip_status IN ('PENDING', 'NO_RESPONSE', 'CALLBACK_SCHEDULED'))::int as pending_count
        FROM logistics_trips
      `),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE priority = 'urgent')::int as urgent_count,
          COUNT(*) FILTER (WHERE priority = 'high')::int as high_count
        FROM logistics_call_outcomes
        WHERE escalate_to_human = 'yes' OR priority IN ('high', 'urgent')
      `),
    ]);
    return {
      ...tripStats.rows[0],
      ...escStats.rows[0],
    };
  }
}

export const logisticsCallService = new LogisticsCallService();
