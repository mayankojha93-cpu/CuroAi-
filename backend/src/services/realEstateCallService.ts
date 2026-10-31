import { randomUUID } from 'crypto';
import {
  SipClient,
  AgentDispatchClient,
  RoomServiceClient,
  SipCallError,
} from 'livekit-server-sdk';
import { pool, query } from '../db/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { normalizePhone } from '../utils/csvParser.js';

export interface RealEstateLeadRecord {
  id: string;
  campaign_id: string | null;
  owner_name: string;
  phone: string;
  alternate_phone: string | null;
  email: string | null;
  preferred_language: string;
  lead_status: string;
  current_disposition: string | null;
  total_attempts: number;
  max_attempts: number;
  last_called_at: string | null;
  next_attempt_time: string | null;
  notes: string | null;
  created_at: string;
}

export interface SaveRealEstateOutcomeInput {
  lead_id?: string | null;
  final_disposition: string;
  is_interested?: boolean | null;
  owner_name_confirmed?: string | null;
  category?: string | null;
  intent?: string | null;
  project_or_society?: string | null;
  sector_or_location?: string | null;
  unit_number?: string | null;
  floor_number?: string | null;
  bhk_config?: string | null;
  commercial_type?: string | null;
  approx_area_sqft?: number | null;
  furnishing_status?: string | null;
  expected_sale_price?: string | null;
  expected_monthly_rent?: string | null;
  is_currently_leased?: boolean | null;
  current_rent_received?: string | null;
  immediate_occupancy?: boolean | null;
  agent_summary?: string | null;
  transcript?: any;
  duration_seconds?: number | null;
  median_latency_ms?: number | null;
}

export class RealEstateCallService {
  private sipClient: SipClient;
  private dispatchClient: AgentDispatchClient;
  private roomService: RoomServiceClient;

  constructor() {
    this.sipClient = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    this.dispatchClient = new AgentDispatchClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    this.roomService = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }

  /**
   * Places a test call for the My Estate Finder agent
   */
  async initiateTestCall(data: {
    phone: string;
    owner_name?: string;
    name?: string;
    language?: string;
    notes?: string;
  }) {
    const ownerName = data.owner_name || data.name || 'Test Property Owner';
    const normalizedPhone = normalizePhone(data.phone);

    // Reuse existing lead or create new lead
    const existingLead = await query(`SELECT * FROM real_estate_leads WHERE phone = $1 LIMIT 1`, [normalizedPhone]);
    let lead: any;

    if (existingLead.rows.length > 0) {
      const upd = await query(
        `UPDATE real_estate_leads
         SET owner_name = COALESCE($1, owner_name),
             preferred_language = COALESCE($2, preferred_language),
             notes = COALESCE($3, notes),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [ownerName, data.language || 'en', data.notes || 'Developer Test Call', existingLead.rows[0].id]
      );
      lead = upd.rows[0];
    } else {
      const ins = await query(
        `INSERT INTO real_estate_leads (owner_name, phone, preferred_language, notes, total_attempts, max_attempts)
         VALUES ($1, $2, $3, $4, 0, 3)
         RETURNING *`,
        [ownerName, normalizedPhone, data.language || 'en', data.notes || 'Developer Test Call']
      );
      lead = ins.rows[0];
    }

    const callId = randomUUID();
    const roomName = `re-call-${callId}`;

    const insertCall = await query(
      `INSERT INTO calls (
         id, re_lead_id, status, call_status, attempt_number, room_name, direction,
         script, company_name, voice_pipeline, is_test_call
       )
       VALUES ($1, $2, 'initiated', 'initiated', 1, $3, 'outbound',
               'My Estate Finder — Property Intake', 'My Estate Finder', 'Sarvam AI (Aditya - hi-IN)', TRUE)
       RETURNING *`,
      [callId, lead?.id || null, roomName]
    );
    const call = insertCall.rows[0];

    this.executeOutboundWorkflow(callId, lead || { id: null, owner_name: ownerName, phone: normalizedPhone }, roomName)
      .catch((err) => {
        logger.error({ err, callId }, 'Unhandled error in real estate outbound call workflow');
      });

    return { call, lead };
  }

  /**
   * Initiates an outbound call to an existing real_estate_lead
   */
  async initiateCall(leadId: string) {
    const leadRes = await query(`SELECT * FROM real_estate_leads WHERE id = $1`, [leadId]);
    if (leadRes.rows.length === 0) {
      throw new AppError(`Real estate lead not found: ${leadId}`, 404);
    }
    const lead = leadRes.rows[0];

    const callId = randomUUID();
    const roomName = `re-call-${callId}`;

    // Atomically increment attempts
    const updLead = await query(
      `UPDATE real_estate_leads
       SET total_attempts = COALESCE(total_attempts, 0) + 1, last_called_at = NOW()
       WHERE id = $1
       RETURNING total_attempts`,
      [leadId]
    );
    const attempt = updLead.rows[0].total_attempts;

    const insCall = await query(
      `INSERT INTO calls (
         id, re_lead_id, campaign_id, status, call_status, attempt_number, room_name, direction,
         script, company_name, voice_pipeline
       )
       VALUES ($1, $2, $3, 'initiated', 'initiated', $4, $5, 'outbound',
               'My Estate Finder — Property Intake', 'My Estate Finder', 'Sarvam AI (Aditya - hi-IN)')
       RETURNING *`,
      [callId, leadId, lead.campaign_id, attempt, roomName]
    );
    const call = insCall.rows[0];

    this.executeOutboundWorkflow(callId, lead, roomName).catch((err) => {
      logger.error({ err, callId }, 'Unhandled error in real estate outbound call workflow');
    });

    return call;
  }

  /**
   * Dispatches agent worker and dials SIP participant
   */
  private async executeOutboundWorkflow(callId: string, lead: any, roomName: string) {
    try {
      await this.roomService.createRoom({ name: roomName, emptyTimeout: 300 });

      const agentName = env.REAL_ESTATE_AGENT_NAME || 'my-estate-finder-agent';
      logger.info({ roomName, agentName }, 'Creating real estate agent dispatch');

      await this.dispatchClient.createDispatch(roomName, agentName, {
        metadata: JSON.stringify({
          callId,
          leadId: lead.id,
          ownerName: lead.owner_name || 'Property Owner',
          phone: lead.phone,
          preferredLanguage: lead.preferred_language || 'en',
          direction: 'outbound',
        }),
      });

      if (!env.SIP_OUTBOUND_TRUNK_ID) {
        throw new Error('Missing SIP_OUTBOUND_TRUNK_ID in environment. Check Exotel SIP trunk in .env');
      }

      const dialablePhone = normalizePhone(lead.phone);
      const callerId = env.SIP_CALLER_ID || undefined;

      await query("UPDATE calls SET status = 'dialing', call_status = 'dialing' WHERE id = $1", [callId]);
      logger.info({ callId, phone: dialablePhone }, 'Dispatching Exotel SIP call for Real Estate...');

      const participant = await this.sipClient.createSipParticipant(
        env.SIP_OUTBOUND_TRUNK_ID,
        dialablePhone,
        roomName,
        {
          participantIdentity: `phone-${dialablePhone.replace(/[^0-9]/g, '')}`,
          participantName: lead.owner_name || 'Property Owner',
          fromNumber: callerId,
          waitUntilAnswered: false,
        } as any
      );

      await query('UPDATE calls SET sip_call_id = $1 WHERE id = $2', [participant.sipCallId || null, callId]);
      logger.info({ callId, sipCallId: participant.sipCallId }, 'Real estate call placed to carrier!');
    } catch (err: any) {
      let mappedStatus = 'failed';
      let failureReason = err.message || 'Call placement failed';

      if (err instanceof SipCallError) {
        failureReason = `SIP ${err.sipStatusCode} (${err.sipStatus}): ${err.message}`;
        if (err.sipStatusCode === 486 || err.sipStatusCode === 600) {
          mappedStatus = 'busy';
        } else if (err.sipStatusCode === 408 || err.sipStatusCode === 480) {
          mappedStatus = 'no_answer';
        } else if (err.sipStatusCode === 403) {
          failureReason = `SIP 403 Forbidden: Exotel rejected call. Your Exotel account requires KYC compliance or number verification before making outbound calls.`;
          mappedStatus = 'failed';
        }
      }

      logger.warn({ callId, mappedStatus, failureReason }, 'Real estate dial failed');
      await query(
        `UPDATE calls SET status = $1, call_status = $1, failure_reason = $2, ended_at = NOW() WHERE id = $3`,
        [mappedStatus, failureReason, callId]
      );
    }
  }

  /**
   * Saves outcome and property dossier captured during call
   */
  async saveOutcome(callId: string, data: SaveRealEstateOutcomeInput) {
    const callRes = await query('SELECT id, re_lead_id FROM calls WHERE id = $1', [callId]);
    if (callRes.rows.length === 0) {
      throw new AppError(`Call not found: ${callId}`, 404);
    }
    const call = callRes.rows[0];
    const leadId = data.lead_id || call.re_lead_id;

    // 1. Insert or update property details if any slot was captured
    let propertyId: string | null = null;
    const hasPropertyInfo = Boolean(
      data.category || data.intent || data.project_or_society || data.bhk_config || data.commercial_type
    );

    if (hasPropertyInfo) {
      const existingProp = await query(`SELECT id FROM real_estate_properties WHERE call_id = $1 LIMIT 1`, [callId]);
      if (existingProp.rows.length > 0) {
        propertyId = existingProp.rows[0].id;
        await query(
          `UPDATE real_estate_properties
           SET category = COALESCE($1, category),
               intent = COALESCE($2, intent),
               project_or_society = COALESCE($3, project_or_society),
               sector_or_location = COALESCE($4, sector_or_location),
               unit_number = COALESCE($5, unit_number),
               floor_number = COALESCE($6, floor_number),
               bhk_config = COALESCE($7, bhk_config),
               commercial_type = COALESCE($8, commercial_type),
               approx_area_sqft = COALESCE($9, approx_area_sqft),
               furnishing_status = COALESCE($10, furnishing_status),
               expected_sale_price = COALESCE($11, expected_sale_price),
               expected_monthly_rent = COALESCE($12, expected_monthly_rent),
               is_currently_leased = COALESCE($13, is_currently_leased),
               current_rent_received = COALESCE($14, current_rent_received),
               immediate_occupancy = COALESCE($15, immediate_occupancy),
               raw_notes = COALESCE($16, raw_notes)
           WHERE id = $17`,
          [
            data.category || null,
            data.intent || null,
            data.project_or_society || null,
            data.sector_or_location || null,
            data.unit_number || null,
            data.floor_number || null,
            data.bhk_config || null,
            data.commercial_type || null,
            data.approx_area_sqft || null,
            data.furnishing_status || null,
            data.expected_sale_price || null,
            data.expected_monthly_rent || null,
            data.is_currently_leased ?? null,
            data.current_rent_received || null,
            data.immediate_occupancy ?? null,
            data.agent_summary || null,
            propertyId,
          ]
        );
      } else {
        const propRes = await query(
          `INSERT INTO real_estate_properties (
             lead_id, call_id, category, intent, project_or_society, sector_or_location,
             unit_number, floor_number, bhk_config, commercial_type, approx_area_sqft,
             furnishing_status, expected_sale_price, expected_monthly_rent,
             is_currently_leased, current_rent_received, immediate_occupancy, raw_notes
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           RETURNING id`,
          [
            leadId || null,
            callId,
            data.category || null,
            data.intent || null,
            data.project_or_society || null,
            data.sector_or_location || null,
            data.unit_number || null,
            data.floor_number || null,
            data.bhk_config || null,
            data.commercial_type || null,
            data.approx_area_sqft || null,
            data.furnishing_status || null,
            data.expected_sale_price || null,
            data.expected_monthly_rent || null,
            data.is_currently_leased ?? false,
            data.current_rent_received || null,
            data.immediate_occupancy ?? true,
            data.agent_summary || null,
          ]
        );
        propertyId = propRes.rows[0]?.id || null;
      }
    }

    // 2. Save real_estate_outcomes
    const transcriptJson = data.transcript ? JSON.stringify(data.transcript) : null;
    const outcomeRes = await query(
      `INSERT INTO real_estate_outcomes (
         call_id, lead_id, property_id, final_disposition, is_interested,
         owner_name_confirmed, transcript, agent_summary, duration_seconds, median_latency_ms
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (call_id)
       DO UPDATE SET
         final_disposition = EXCLUDED.final_disposition,
         is_interested = EXCLUDED.is_interested,
         owner_name_confirmed = EXCLUDED.owner_name_confirmed,
         property_id = COALESCE(EXCLUDED.property_id, real_estate_outcomes.property_id),
         transcript = EXCLUDED.transcript,
         agent_summary = EXCLUDED.agent_summary,
         duration_seconds = EXCLUDED.duration_seconds,
         median_latency_ms = EXCLUDED.median_latency_ms
       RETURNING *`,
      [
        callId,
        leadId || null,
        propertyId,
        data.final_disposition,
        data.is_interested ?? null,
        data.owner_name_confirmed || null,
        transcriptJson,
        data.agent_summary || null,
        data.duration_seconds || 0,
        data.median_latency_ms || null,
      ]
    );

    // 3. Update call record status
    let mappedStatus = 'completed';
    const disp = data.final_disposition.toLowerCase();
    if (disp.includes('not connected') || disp.includes('no answer')) {
      mappedStatus = 'no_answer';
    } else if (disp.includes('failed') || disp.includes('wrong number')) {
      mappedStatus = 'failed';
    }

    await query(
      `UPDATE calls
       SET status = $1,
           call_status = $2,
           duration_seconds = $3,
           median_latency_ms = $4,
           answered_at = COALESCE(answered_at, CASE WHEN $3 > 0 THEN NOW() - ($3 || ' seconds')::interval ELSE NOW() END),
           ended_at = NOW()
       WHERE id = $5`,
      [mappedStatus, data.final_disposition, data.duration_seconds || 0, data.median_latency_ms || null, callId]
    );

    // 4. Update lead status if lead exists
    if (leadId) {
      let leadStatus = 'CONTACTED';
      if (disp.includes('dnc') || disp.includes('do not call')) leadStatus = 'DNC';
      else if (disp.includes('whatsapp')) leadStatus = 'WHATSAPP_REQUESTED';
      else if (disp.includes('advisor') || disp.includes('callback')) leadStatus = 'CALLBACK';
      else if (data.is_interested) leadStatus = 'QUALIFIED';
      else if (disp.includes('not interested')) leadStatus = 'NOT_INTERESTED';
      else if (disp.includes('wrong number')) leadStatus = 'WRONG_NUMBER';

      await query(
        `UPDATE real_estate_leads
         SET lead_status = $1,
             current_disposition = $2,
             owner_name = COALESCE($3, owner_name),
             updated_at = NOW()
         WHERE id = $4`,
        [leadStatus, data.final_disposition, data.owner_name_confirmed || null, leadId]
      );
    }

    return outcomeRes.rows[0];
  }

  /**
   * Retrieves list of real estate leads
   */
  async getLeads(params?: { status?: string; limit?: number; offset?: number }) {
    const limit = params?.limit || 50;
    const offset = params?.offset || 0;
    let sql = `SELECT * FROM real_estate_leads`;
    const args: any[] = [];

    if (params?.status) {
      sql += ` WHERE lead_status = $1`;
      args.push(params.status);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`;
    args.push(limit, offset);

    const res = await query(sql, args);
    return res.rows;
  }

  /**
   * Retrieves captured properties with their associated leads and calls
   */
  async getProperties(params?: { category?: string; intent?: string; limit?: number }) {
    const limit = params?.limit || 50;
    let sql = `
      SELECT p.*, l.owner_name, l.phone, l.email, c.created_at as call_time, c.duration_seconds, o.final_disposition
      FROM real_estate_properties p
      LEFT JOIN real_estate_leads l ON p.lead_id = l.id
      LEFT JOIN calls c ON p.call_id = c.id
      LEFT JOIN real_estate_outcomes o ON p.call_id = o.call_id
      WHERE 1=1
    `;
    const args: any[] = [];

    if (params?.category) {
      args.push(params.category.toLowerCase());
      sql += ` AND LOWER(p.category) = $${args.length}`;
    }
    if (params?.intent) {
      args.push(params.intent.toLowerCase());
      sql += ` AND LOWER(p.intent) = $${args.length}`;
    }

    sql += ` ORDER BY p.created_at DESC LIMIT $${args.length + 1}`;
    args.push(limit);

    const res = await query(sql, args);
    return res.rows;
  }
}

export const realEstateCallService = new RealEstateCallService();

