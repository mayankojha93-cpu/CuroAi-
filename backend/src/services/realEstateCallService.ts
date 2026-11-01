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
import { matchRealEstateDisposition, RealEstateCanonicalDisposition } from '../utils/realEstateDispositions.js';

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

/**
 * Strips Devanagari/Hindi characters to guarantee clean English-only strings
 */
export function cleanToEnglishOnly(str?: string | null): string {
  if (!str) return '';
  return str
    .replace(/\s*\([\u0900-\u097F\s\-,./]+\)/g, '')
    .replace(/[\u0900-\u097F]+/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
    const normalizedPhone = normalizePhone(data.phone);
    const isTestCustomerPhone =
      normalizedPhone.includes('8658250208') ||
      (Boolean(env.TEST_PHONE) && normalizePhone(env.TEST_PHONE) === normalizedPhone);
    const defaultTestName = env.TEST_CUSTOMER_NAME || 'Raja Nayak';
    const passedName = data.owner_name || data.name || (isTestCustomerPhone ? defaultTestName : undefined);
    const ownerName = passedName || (isTestCustomerPhone ? defaultTestName : 'Test Property Owner');

    // Reuse existing lead or create new lead
    const existingLead = await query(`SELECT * FROM real_estate_leads WHERE phone = $1 LIMIT 1`, [normalizedPhone]);
    let lead: any;

    if (existingLead.rows.length > 0) {
      const nameToUpdate = passedName || (isTestCustomerPhone ? defaultTestName : null);
      const upd = await query(
        `UPDATE real_estate_leads
         SET owner_name = COALESCE($1, owner_name),
             preferred_language = COALESCE($2, preferred_language),
             notes = COALESCE($3, notes),
             total_attempts = COALESCE(total_attempts, 0) + 1,
             last_called_at = NOW(),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [nameToUpdate, data.language || 'en', data.notes || 'Developer Test Call', existingLead.rows[0].id]
      );
      lead = upd.rows[0];
    } else {
      const ins = await query(
        `INSERT INTO real_estate_leads (owner_name, phone, preferred_language, notes, total_attempts, max_attempts, last_called_at)
         VALUES ($1, $2, $3, $4, 1, 3, NOW())
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
         script, company_name, voice_pipeline, is_test_call, pipeline
       )
       VALUES ($1, $2, 'initiated', 'initiated', $3, $4, 'outbound',
               'My Estate Finder — Property Intake', 'My Estate Finder', 'Sarvam AI (Shubh - en-IN)', TRUE, 'real_estate')
       RETURNING *`,
      [callId, lead?.id || null, lead?.total_attempts || 1, roomName]
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
         script, company_name, voice_pipeline, pipeline
       )
       VALUES ($1, $2, $3, 'initiated', 'initiated', $4, $5, 'outbound',
               'My Estate Finder — Property Intake', 'My Estate Finder', 'Sarvam AI (Shubh - en-IN)', 'real_estate')
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
   * Intelligently extract property details and owner information from the call transcript.
   * Uses OpenRouter LLM structured extraction when available, with an instant deterministic regex fallback.
   */
  async extractDetailsFromTranscript(transcript: any): Promise<Partial<SaveRealEstateOutcomeInput>> {
    let turns: Array<{ role?: string; text?: string; message?: string }> = [];
    if (Array.isArray(transcript)) {
      turns = transcript;
    } else if (typeof transcript === 'string' && transcript.trim()) {
      try {
        const parsed = JSON.parse(transcript);
        if (Array.isArray(parsed)) turns = parsed;
      } catch {}
    }

    if (turns.length === 0) return {};

    const dialogueText = turns
      .map((t) => `${(t.role || 'user').toLowerCase()}: ${t.text || t.message || ''}`)
      .join('\n');

    const result: Partial<SaveRealEstateOutcomeInput> = {};

    // 1. LLM Structured Extraction via OpenRouter if key is configured
    const openrouterKey = env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
    if (openrouterKey && dialogueText.length > 50) {
      try {
        const prompt = `Extract all property details and owner information from this real estate intake phone call transcript.
Ensure all names, locations, and society names are written strictly in English (Latin alphabet), never in Devanagari or Hindi script.
Return ONLY valid JSON matching this exact schema:
{
  "owner_name": string or null,
  "category": "residential" or "commercial" or null,
  "intent": "sale" or "lease" or null,
  "project_or_society": string or null,
  "sector_or_location": string or null,
  "unit_number": string or null,
  "floor_number": string or null,
  "bhk_config": string or null,
  "commercial_type": string or null,
  "approx_area_sqft": number or null,
  "furnishing_status": string or null,
  "expected_sale_price": string or null,
  "expected_monthly_rent": string or null,
  "is_currently_leased": boolean or null,
  "immediate_occupancy": boolean or null,
  "agent_summary": string or null
}

Transcript:
${dialogueText.slice(0, 4000)}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4500);

        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openrouterKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.1,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (resp.ok) {
          const json: any = await resp.json();
          const content = json.choices?.[0]?.message?.content;
          if (content) {
            const parsed = JSON.parse(content);
            if (parsed.project_or_society) result.project_or_society = cleanToEnglishOnly(String(parsed.project_or_society));
            if (parsed.sector_or_location) result.sector_or_location = cleanToEnglishOnly(String(parsed.sector_or_location));
            if (parsed.unit_number) result.unit_number = cleanToEnglishOnly(String(parsed.unit_number));
            if (parsed.floor_number) result.floor_number = cleanToEnglishOnly(String(parsed.floor_number));
            if (parsed.bhk_config) result.bhk_config = cleanToEnglishOnly(String(parsed.bhk_config));
            if (parsed.commercial_type) result.commercial_type = cleanToEnglishOnly(String(parsed.commercial_type));
            if (parsed.approx_area_sqft) result.approx_area_sqft = Number(parsed.approx_area_sqft) || undefined;
            if (parsed.furnishing_status) result.furnishing_status = cleanToEnglishOnly(String(parsed.furnishing_status));
            if (parsed.expected_sale_price) result.expected_sale_price = cleanToEnglishOnly(String(parsed.expected_sale_price));
            if (parsed.expected_monthly_rent) result.expected_monthly_rent = cleanToEnglishOnly(String(parsed.expected_monthly_rent));
            if (parsed.category) result.category = parsed.category.toLowerCase().includes('comm') ? 'commercial' : 'residential';
            if (parsed.intent) result.intent = (parsed.intent.toLowerCase().includes('rent') || parsed.intent.toLowerCase().includes('lease')) ? 'lease' : 'sale';
            if (parsed.owner_name) result.owner_name_confirmed = cleanToEnglishOnly(String(parsed.owner_name));
            if (parsed.agent_summary) result.agent_summary = cleanToEnglishOnly(String(parsed.agent_summary));
            if (typeof parsed.is_currently_leased === 'boolean') result.is_currently_leased = parsed.is_currently_leased;
            if (typeof parsed.immediate_occupancy === 'boolean') result.immediate_occupancy = parsed.immediate_occupancy;
          }
        }
      } catch (err) {
        logger.warn({ err }, 'OpenRouter transcript extraction skipped or timed out, using rule-based parser');
      }
    }

    // 2. Deterministic Rule-Based Fallback Parser (Ensures extraction even if LLM fails or is offline)
    const lowerText = dialogueText.toLowerCase();

    // Owner Name: "मेरा नाम मयंक ओझा है" or "naam Mayank"
    if (!result.owner_name_confirmed) {
      const nameMatch = dialogueText.match(/(?:मेरा नाम(?: है)?|नाम है|name is|i am)\s+([A-Za-z\u0900-\u097F\s]{2,30}?)(?=[।.,\n]|$)/i);
      if (nameMatch && nameMatch[1]) {
        result.owner_name_confirmed = nameMatch[1].trim();
      }
    }

    // Category
    if (!result.category) {
      if (lowerText.includes('कमर्शियल') || lowerText.includes('commercial')) {
        result.category = 'commercial';
      } else if (lowerText.includes('रेजिडेंशियल') || lowerText.includes('रेसिडेंशियल') || lowerText.includes('residential')) {
        result.category = 'residential';
      }
    }

    // Intent
    if (!result.intent) {
      if (lowerText.includes('रेंट') || lowerText.includes('rent') || lowerText.includes('किराए') || lowerText.includes('lease')) {
        result.intent = 'lease';
      } else if (lowerText.includes('सेल') || lowerText.includes('बेचना') || lowerText.includes('sell') || lowerText.includes('sale')) {
        result.intent = 'sale';
      }
    }

    // Sector
    if (!result.sector_or_location) {
      const secMatch = dialogueText.match(/(?:सेक्टर|sector)\s*([0-9A-Za-z\-]+)/i);
      if (secMatch) {
        result.sector_or_location = `Sector ${secMatch[1].trim()}`;
      }
    }

    // Unit Number
    if (!result.unit_number) {
      const unitMatch = dialogueText.match(/(?:यूनिट नंबर|यूनिट नं|unit number|unit no|unit)\s*[:\-]?\s*([0-9A-Za-z\-]+)/i);
      if (unitMatch) {
        result.unit_number = unitMatch[1].trim();
      }
    }

    // Floor Number
    if (!result.floor_number) {
      if (lowerText.includes('फोर्थ फ्लोर') || lowerText.includes('4th floor') || lowerText.includes('fourth floor')) {
        result.floor_number = '4';
      } else if (lowerText.includes('ग्राउंड फ्लोर') || lowerText.includes('ground floor')) {
        result.floor_number = 'Ground';
      } else if (lowerText.includes('फर्स्ट फ्लोर') || lowerText.includes('1st floor') || lowerText.includes('first floor')) {
        result.floor_number = '1';
      } else if (lowerText.includes('सेकंड फ्लोर') || lowerText.includes('2nd floor') || lowerText.includes('second floor')) {
        result.floor_number = '2';
      } else if (lowerText.includes('थर्ड फ्लोर') || lowerText.includes('3rd floor') || lowerText.includes('third floor')) {
        result.floor_number = '3';
      } else {
        const floorMatch = dialogueText.match(/([0-9]+)\s*(?:th|st|nd|rd)?\s*(?:फ्लोर|floor)/i);
        if (floorMatch) result.floor_number = floorMatch[1].trim();
      }
    }

    // Building / Project Name
    if (!result.project_or_society) {
      const projMatch = dialogueText.match(/(?:प्रोजेक्ट का नाम है|प्रोजेक्ट है|बिल्डिंग का नाम|society name is|project name is)\s*[:\-]?\s*([A-Za-z0-9\u0900-\u097F\s\-]+?)(?=[।.,\n]|$)/i);
      if (projMatch && projMatch[1]) {
        result.project_or_society = projMatch[1].trim();
      }
    }

    return result;
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

    // Automatic transcript extraction fallback if property details are missing
    if (data.transcript && (!data.project_or_society || !data.sector_or_location || !data.unit_number || !data.bhk_config)) {
      try {
        const extracted = await this.extractDetailsFromTranscript(data.transcript);
        if (extracted.project_or_society && !data.project_or_society) data.project_or_society = extracted.project_or_society;
        if (extracted.sector_or_location && !data.sector_or_location) data.sector_or_location = extracted.sector_or_location;
        if (extracted.unit_number && !data.unit_number) data.unit_number = extracted.unit_number;
        if (extracted.floor_number && !data.floor_number) data.floor_number = extracted.floor_number;
        if (extracted.bhk_config && !data.bhk_config) data.bhk_config = extracted.bhk_config;
        if (extracted.commercial_type && !data.commercial_type) data.commercial_type = extracted.commercial_type;
        if (extracted.approx_area_sqft !== undefined && data.approx_area_sqft === undefined) data.approx_area_sqft = extracted.approx_area_sqft;
        if (extracted.furnishing_status && !data.furnishing_status) data.furnishing_status = extracted.furnishing_status;
        if (extracted.expected_sale_price && !data.expected_sale_price) data.expected_sale_price = extracted.expected_sale_price;
        if (extracted.expected_monthly_rent && !data.expected_monthly_rent) data.expected_monthly_rent = extracted.expected_monthly_rent;
        if (extracted.category && !data.category) data.category = extracted.category;
        if (extracted.intent && !data.intent) data.intent = extracted.intent;
        if (extracted.owner_name_confirmed && !data.owner_name_confirmed) data.owner_name_confirmed = extracted.owner_name_confirmed;
        if (extracted.agent_summary && !data.agent_summary) data.agent_summary = extracted.agent_summary;
        if (typeof extracted.is_currently_leased === 'boolean' && data.is_currently_leased === undefined) data.is_currently_leased = extracted.is_currently_leased;
        if (typeof extracted.immediate_occupancy === 'boolean' && data.immediate_occupancy === undefined) data.immediate_occupancy = extracted.immediate_occupancy;
      } catch (err) {
        logger.warn({ err }, 'Error during transcript extraction in saveOutcome');
      }
    }

    // 1. Insert or update property details if any slot was captured
    let propertyId: string | null = null;
    const hasPropertyInfo = Boolean(
      data.category ||
      data.intent ||
      data.project_or_society ||
      data.sector_or_location ||
      data.unit_number ||
      data.floor_number ||
      data.bhk_config ||
      data.commercial_type ||
      data.approx_area_sqft ||
      data.expected_sale_price ||
      data.expected_monthly_rent
    );

    // Sanitize category & intent to strictly adhere to Postgres CHECK constraints
    let cleanCategory: string | null = null;
    if (data.category) {
      cleanCategory = data.category.toLowerCase().includes('comm') ? 'commercial' : 'residential';
    }
    let cleanIntent: string | null = null;
    if (data.intent) {
      cleanIntent = (data.intent.toLowerCase().includes('rent') || data.intent.toLowerCase().includes('lease')) ? 'lease' : 'sale';
    }

    // Defensive parsing for numeric area
    let cleanArea: number | null = null;
    if (data.approx_area_sqft !== undefined && data.approx_area_sqft !== null) {
      if (typeof data.approx_area_sqft === 'number') {
        cleanArea = isNaN(data.approx_area_sqft) ? null : data.approx_area_sqft;
      } else {
        const match = String(data.approx_area_sqft).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
        cleanArea = match ? parseFloat(match[1]) : null;
      }
    }

    // Defensive boolean parsing for lease status & immediate occupancy
    let cleanIsLeased: boolean | null = null;
    if (data.is_currently_leased !== undefined && data.is_currently_leased !== null) {
      if (typeof data.is_currently_leased === 'boolean') {
        cleanIsLeased = data.is_currently_leased;
      } else {
        const s = String(data.is_currently_leased).toLowerCase().trim();
        cleanIsLeased = s === 'true' || s === 'yes' || s === '1' || s.includes('leased') || s.includes('rented');
      }
    }

    let cleanImmOcc: boolean | null = null;
    if (data.immediate_occupancy !== undefined && data.immediate_occupancy !== null) {
      if (typeof data.immediate_occupancy === 'boolean') {
        cleanImmOcc = data.immediate_occupancy;
      } else {
        const s = String(data.immediate_occupancy).toLowerCase().trim();
        cleanImmOcc = s === 'true' || s === 'yes' || s === '1' || s.includes('immediate') || s.includes('ready');
      }
    }

    // Defensively slice strings to adhere to database column limits and enforce clean English only
    const safeSociety = data.project_or_society ? cleanToEnglishOnly(data.project_or_society).slice(0, 255) : null;
    const safeLocation = data.sector_or_location ? cleanToEnglishOnly(data.sector_or_location).slice(0, 255) : null;
    const safeUnit = data.unit_number ? cleanToEnglishOnly(String(data.unit_number)).slice(0, 64) : null;
    const safeFloor = data.floor_number ? cleanToEnglishOnly(String(data.floor_number)).slice(0, 64) : null;
    const safeBhk = data.bhk_config ? cleanToEnglishOnly(data.bhk_config).slice(0, 64) : null;
    const safeCommercialType = data.commercial_type ? cleanToEnglishOnly(data.commercial_type).slice(0, 64) : null;
    const safeFurnishing = data.furnishing_status ? cleanToEnglishOnly(data.furnishing_status).slice(0, 64) : null;
    const safePrice = data.expected_sale_price ? cleanToEnglishOnly(String(data.expected_sale_price)).slice(0, 128) : null;
    const safeRent = data.expected_monthly_rent ? cleanToEnglishOnly(String(data.expected_monthly_rent)).slice(0, 128) : null;
    const safeCurrentRent = data.current_rent_received ? cleanToEnglishOnly(String(data.current_rent_received)).slice(0, 128) : null;
    const safeOwnerConfirmed = data.owner_name_confirmed ? cleanToEnglishOnly(data.owner_name_confirmed).slice(0, 255) : null;

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
            cleanCategory,
            cleanIntent,
            safeSociety,
            safeLocation,
            safeUnit,
            safeFloor,
            safeBhk,
            safeCommercialType,
            cleanArea,
            safeFurnishing,
            safePrice,
            safeRent,
            cleanIsLeased,
            safeCurrentRent,
            cleanImmOcc,
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
            cleanCategory,
            cleanIntent,
            safeSociety,
            safeLocation,
            safeUnit,
            safeFloor,
            safeBhk,
            safeCommercialType,
            cleanArea,
            safeFurnishing,
            safePrice,
            safeRent,
            cleanIsLeased ?? false,
            safeCurrentRent,
            cleanImmOcc ?? true,
            data.agent_summary || null,
          ]
        );
        propertyId = propRes.rows[0]?.id || null;
      }
    }

    // 2. Standardize disposition to 2nd pipeline Canonical Dispositions
    const canonicalDisp: RealEstateCanonicalDisposition = matchRealEstateDisposition(
      data.final_disposition,
      data.duration_seconds,
      call.status
    );

    // 3. Save real_estate_outcomes
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
        canonicalDisp,
        data.is_interested ?? null,
        safeOwnerConfirmed,
        transcriptJson,
        data.agent_summary || null,
        data.duration_seconds || 0,
        data.median_latency_ms || null,
      ]
    );

    // 4. Update call record status
    let mappedStatus = 'completed';
    if (canonicalDisp === 'Not Connected (No Answer)') {
      mappedStatus = 'no_answer';
    } else if (canonicalDisp === 'Wrong Number') {
      mappedStatus = 'failed';
    }

    await query(
      `UPDATE calls
       SET status = $1,
           call_status = $2,
           duration_seconds = GREATEST($3, COALESCE(duration_seconds, 0)),
           median_latency_ms = $4,
           answered_at = COALESCE(answered_at, CASE WHEN $3 > 0 THEN NOW() - ($3 || ' seconds')::interval ELSE NOW() END),
           ended_at = NOW()
       WHERE id = $5`,
      [mappedStatus, canonicalDisp, data.duration_seconds || 0, data.median_latency_ms || null, callId]
    );

    // 5. Update lead status if lead exists
    if (leadId) {
      let leadStatus = 'CONTACTED';
      if (canonicalDisp === 'Qualified Lead') leadStatus = 'QUALIFIED';
      else if (canonicalDisp === 'Schedule Callback' || canonicalDisp === 'Advisor Callback Booked') leadStatus = 'CALLBACK';
      else if (canonicalDisp === 'WhatsApp Info Requested') leadStatus = 'WHATSAPP_REQUESTED';
      else if (canonicalDisp === 'Not Interested') leadStatus = 'NOT_INTERESTED';
      else if (canonicalDisp === 'Do Not Call') leadStatus = 'DNC';
      else if (canonicalDisp === 'Wrong Number') leadStatus = 'WRONG_NUMBER';
      else if (canonicalDisp === 'Not Connected (No Answer)') leadStatus = 'NO_ANSWER';

      await query(
        `UPDATE real_estate_leads
         SET lead_status = $1,
             current_disposition = $2,
             owner_name = COALESCE($3, owner_name),
             updated_at = NOW()
         WHERE id = $4`,
        [leadStatus, canonicalDisp, safeOwnerConfirmed || null, leadId]
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
    return res.rows.map((row: any) => ({
      ...row,
      current_disposition: row.current_disposition
        ? matchRealEstateDisposition(row.current_disposition)
        : null,
    }));
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
    return res.rows.map((row: any) => ({
      ...row,
      final_disposition: row.final_disposition
        ? matchRealEstateDisposition(row.final_disposition, row.duration_seconds)
        : null,
    }));
  }

  /**
   * Automatically backfill missing property details from transcripts for any existing real estate calls
   */
  async autoBackfillMissingDetails() {
    try {
      const candidates = await query(`
        SELECT c.id as call_id, ro.transcript, ro.property_id, rp.id as existing_prop_id
        FROM calls c
        JOIN real_estate_outcomes ro ON c.id = ro.call_id
        LEFT JOIN real_estate_properties rp ON ro.property_id = rp.id
        WHERE c.pipeline = 'real_estate'
          AND ro.transcript IS NOT NULL
          AND (rp.project_or_society IS NULL OR rp.sector_or_location IS NULL OR rp.unit_number IS NULL)
      `);

      for (const row of candidates.rows) {
        if (!row.transcript) continue;
        const extracted = await this.extractDetailsFromTranscript(row.transcript);
        if (extracted.project_or_society || extracted.sector_or_location || extracted.unit_number || extracted.category) {
          logger.info({ callId: row.call_id, extracted }, 'Auto-backfilled missing property details from transcript');
          if (row.existing_prop_id) {
            await query(
              `UPDATE real_estate_properties
               SET project_or_society = COALESCE($1, project_or_society),
                   sector_or_location = COALESCE($2, sector_or_location),
                   unit_number = COALESCE($3, unit_number),
                   floor_number = COALESCE($4, floor_number),
                   bhk_config = COALESCE($5, bhk_config),
                   commercial_type = COALESCE($6, commercial_type),
                   approx_area_sqft = COALESCE($7, approx_area_sqft),
                   furnishing_status = COALESCE($8, furnishing_status),
                   expected_sale_price = COALESCE($9, expected_sale_price),
                   expected_monthly_rent = COALESCE($10, expected_monthly_rent),
                   category = COALESCE($11, category),
                   intent = COALESCE($12, intent),
                   raw_notes = COALESCE($13, raw_notes)
               WHERE id = $14`,
              [
                extracted.project_or_society || null,
                extracted.sector_or_location || null,
                extracted.unit_number || null,
                extracted.floor_number || null,
                extracted.bhk_config || null,
                extracted.commercial_type || null,
                extracted.approx_area_sqft || null,
                extracted.furnishing_status || null,
                extracted.expected_sale_price || null,
                extracted.expected_monthly_rent || null,
                extracted.category || null,
                extracted.intent || null,
                extracted.agent_summary || null,
                row.existing_prop_id,
              ]
            );
          } else {
            // Insert property if none existed
            const newProp = await query(
              `INSERT INTO real_estate_properties (
                 call_id, category, intent, project_or_society, sector_or_location,
                 unit_number, floor_number, bhk_config, commercial_type, raw_notes
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               RETURNING id`,
              [
                row.call_id,
                extracted.category || 'residential',
                extracted.intent || 'sale',
                extracted.project_or_society || null,
                extracted.sector_or_location || null,
                extracted.unit_number || null,
                extracted.floor_number || null,
                extracted.bhk_config || null,
                extracted.commercial_type || null,
                extracted.agent_summary || null,
              ]
            );
            if (newProp.rows[0]?.id) {
              await query(`UPDATE real_estate_outcomes SET property_id = $1 WHERE call_id = $2`, [newProp.rows[0].id, row.call_id]);
            }
          }

          if (extracted.owner_name_confirmed) {
            await query(`UPDATE real_estate_outcomes SET owner_name_confirmed = $1 WHERE call_id = $2`, [extracted.owner_name_confirmed, row.call_id]);
            await query(`UPDATE real_estate_leads SET owner_name = $1 WHERE id = (SELECT re_lead_id FROM calls WHERE id = $2)`, [extracted.owner_name_confirmed, row.call_id]);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Error during auto-backfill of missing real estate property details');
    }
  }
}

export const realEstateCallService = new RealEstateCallService();

