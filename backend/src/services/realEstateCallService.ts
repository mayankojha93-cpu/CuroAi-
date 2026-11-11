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
import { romanizeTranscript } from '../utils/transliteration.js';
import { complianceService } from './complianceService.js';
import { initiateExotelWssCall } from './exotelService.js';

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
  language?: string | null;
  initial_language?: string | null;
  language_switched?: boolean | null;
  recording_url?: string | null;
  failure_reason?: string | null;
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
    property_location?: string;
    address?: string;
    notes?: string;
  }) {
    const normalizedPhone = normalizePhone(data.phone);
    if (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 10) {
      throw new AppError('A valid 10-digit phone number is required to place a call', 400);
    }

    // In manual test call mode: auto-clear any previous test suppression so testing is never blocked
    try {
      await query(`
        UPDATE real_estate_leads 
        SET lead_status = 'PENDING', current_disposition = 'Pending Outreach'
        WHERE phone = $1
      `, [normalizedPhone]);
      await query(`
        UPDATE customers 
        SET is_closed = FALSE, current_disposition = 'Pending Outreach'
        WHERE phone = $1
      `, [normalizedPhone]);
      await query(`
        DELETE FROM suppressed_contacts WHERE phone = $1
      `, [normalizedPhone]);
    } catch (e) {
      logger.warn({ e, phone: normalizedPhone }, 'Could not auto-clear suppression for test call');
    }

    const rawPassedName = (data.owner_name || data.name || '').trim();
    // Only accept genuine names; never default to fake identities
    const ownerName = (rawPassedName && !['test subscriber', 'customer', 'property owner', 'none', 'null', 'undefined'].includes(rawPassedName.toLowerCase()))
      ? rawPassedName
      : null;

    if (!ownerName && env.NODE_ENV === 'production') {
      throw new AppError('A verified owner_name is required before placing outbound calls in production', 400);
    }

    let propertyLocation = (data.property_location || data.address || '').trim() || null;
    if (propertyLocation && ['delhi, 110011, burari, sant nagar', 'none', 'null', 'undefined'].includes(propertyLocation.toLowerCase())) {
      propertyLocation = null;
    }

    const rawLang = (data.language || 'en').trim().toLowerCase();
    const cleanLang = (rawLang === 'hi' || rawLang === 'hindi' || rawLang.startsWith('hi-') || rawLang === 'hinglish') ? 'hi' : 'en';

    // Reuse existing lead or create new lead
    const existingLead = await query(`SELECT * FROM real_estate_leads WHERE phone = $1 LIMIT 1`, [normalizedPhone]);
    let lead: any;

    if (!propertyLocation && existingLead.rows.length > 0) {
      const propRes = await query(
        `SELECT sector_or_location, project_or_society FROM real_estate_properties WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [existingLead.rows[0].id]
      );
      if (propRes.rows.length > 0) {
        propertyLocation = (propRes.rows[0].sector_or_location || propRes.rows[0].project_or_society || '').trim() || null;
      }
    }

    if (existingLead.rows.length > 0) {
      const upd = await query(
        `UPDATE real_estate_leads
         SET owner_name = COALESCE($1, owner_name),
             preferred_language = $2,
             notes = COALESCE($3, notes),
             total_attempts = COALESCE(total_attempts, 0) + 1,
             last_called_at = NOW(),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [ownerName, cleanLang, data.notes || 'Developer Test Call', existingLead.rows[0].id]
      );
      lead = upd.rows[0];
    } else {
      const ins = await query(
        `INSERT INTO real_estate_leads (owner_name, phone, preferred_language, notes, total_attempts, max_attempts, last_called_at)
         VALUES ($1, $2, $3, $4, 1, 3, NOW())
         RETURNING *`,
        [ownerName || 'Property Owner', normalizedPhone, cleanLang, data.notes || 'Developer Test Call']
      );
      lead = ins.rows[0];
    }

    const callId = randomUUID();
    const roomName = `re-call-${callId}`;

    const insertCall = await query(
      `INSERT INTO calls (
         id, re_lead_id, status, call_status, attempt_number, room_name, direction,
         script, company_name, voice_pipeline, is_test_call, pipeline, language, initial_language, language_switched
       )
       VALUES ($1, $2, 'initiated', 'initiated', $3, $4, 'outbound',
               'My Estate Finder — Property Intake', 'My Estate Finder', 'Sarvam AI (Priya - hi/en)', TRUE, 'real_estate', $5, $5, FALSE)
       RETURNING *`,
      [callId, lead?.id || null, lead?.total_attempts || 1, roomName, cleanLang]
    );
    const call = insertCall.rows[0];

    this.executeOutboundWorkflow(callId, lead || { id: null, owner_name: ownerName, phone: normalizedPhone }, roomName, propertyLocation)
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

    if (!lead.phone) {
      throw new AppError('Real estate lead phone number is required', 400);
    }

    // Concurrency guard: Do not dial if an active call is already in progress for this lead
    const activeCheck = await query(
      `SELECT id, room_name FROM calls
       WHERE re_lead_id = $1
         AND status IN ('initiated', 'dialing', 'answered')
         AND created_at > NOW() - INTERVAL '10 minutes'
       LIMIT 1`,
      [leadId]
    );
    if (activeCheck.rows.length > 0) {
      logger.warn({ leadId, activeCallId: activeCheck.rows[0].id }, 'Lead already has an active call in progress; skipping duplicate initiation');
      return { call: activeCheck.rows[0], lead };
    }

    if (env.NODE_ENV === 'production') {
      const dndCheck = await complianceService.isDndSuppressed(lead.phone);
      if (dndCheck.suppressed) {
        throw new AppError(dndCheck.reason!, 403);
      }
    }

    const rawOwnerName = (lead.owner_name || '').trim();
    if (env.NODE_ENV === 'production' && (!rawOwnerName || ['property owner', 'test subscriber', 'customer', 'none', 'null'].includes(rawOwnerName.toLowerCase()))) {
      throw new AppError(`Lead ${leadId} requires a verified owner name before placing an outbound call`, 400);
    }

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
         script, company_name, voice_pipeline, pipeline, language, initial_language, language_switched
       )
       VALUES ($1, $2, $3, 'initiated', 'initiated', $4, $5, 'outbound',
               'My Estate Finder — Property Intake', 'My Estate Finder', 'Sarvam AI (Priya - hi/en)', 'real_estate', $6, $6, FALSE)
       RETURNING *`,
      [callId, leadId, lead.campaign_id, attempt, roomName, lead.preferred_language || 'en']
    );
    const call = insCall.rows[0];

    // Query property location if known for this lead (check properties table, fallback to lead.property_location)
    const propRes = await query(
      `SELECT sector_or_location, project_or_society FROM real_estate_properties WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leadId]
    );
    const propertyLocation = (propRes.rows.length > 0 && (propRes.rows[0].sector_or_location || propRes.rows[0].project_or_society))
      ? (propRes.rows[0].sector_or_location || propRes.rows[0].project_or_society || '').trim()
      : (lead.property_location || '').trim() || null;

    this.executeOutboundWorkflow(callId, lead, roomName, propertyLocation).catch((err) => {
      logger.error({ err, callId }, 'Unhandled error in real estate outbound call workflow');
    });

    return call;
  }

  /**
   * Dispatches agent worker and dials SIP participant
   */
  private async executeOutboundWorkflow(callId: string, lead: any, roomName: string, propertyLocation?: string | null) {
    try {
      const rawLeadName = (lead.owner_name || '').trim();
      const safeLeadName = (rawLeadName && !['property owner', 'test subscriber', 'customer', 'none', 'null'].includes(rawLeadName.toLowerCase()))
        ? rawLeadName
        : null;

      const effectiveLocation = (propertyLocation || lead?.property_location || '').trim() || null;

      const metaPayload = JSON.stringify({
        callId,
        leadId: lead.id,
        ownerName: safeLeadName,
        customerName: safeLeadName,
        phone: lead.phone,
        preferredLanguage: lead.preferred_language || 'en',
        direction: 'outbound',
        propertyLocation: effectiveLocation,
        address: effectiveLocation,
        location: effectiveLocation,
        customerAddress: effectiveLocation,
      });

      await this.roomService.createRoom({
        name: roomName,
        emptyTimeout: 300,
        metadata: metaPayload,
      });

      const agentName = env.REAL_ESTATE_AGENT_NAME || 'my-estate-finder-agent';
      logger.info(
        { callId, roomName, agentName, phone: lead.phone, owner: safeLeadName, location: effectiveLocation },
        `📞 [CALL DISPATCH] Room: ${roomName} | Agent: ${agentName} | Lead: ${safeLeadName || 'Owner'} (${lead.phone})`
      );

      await this.dispatchClient.createDispatch(roomName, agentName, {
        metadata: metaPayload,
      });

      const dialablePhone = normalizePhone(lead.phone);
      let callerId = env.SIP_CALLER_ID || undefined;
      if (callerId && callerId.startsWith('+91') && callerId.length === 13) {
        callerId = `0${callerId.slice(3)}`;
      }

      await query("UPDATE calls SET status = 'dialing', call_status = 'dialing' WHERE id = $1", [callId]);

      // Check whether to use Exotel WSS (AgentStream) or standard SIP trunk
      const useWss = env.EXOTEL_USE_WSS !== 'false';
      if (useWss) {
        logger.info({ callId, phone: dialablePhone, callerId }, `📞 [DIALING CARRIER] Dials: ${dialablePhone} via Exotel WSS Audio Stream`);
        const exotelCall = await initiateExotelWssCall({
          callId,
          phone: dialablePhone,
          callerId,
        });

        await query('UPDATE calls SET exotel_call_sid = $1, sip_call_id = $2 WHERE id = $3', [
          exotelCall.sid,
          exotelCall.sid,
          callId,
        ]);
        logger.info(
          { callId, exotelCallSid: exotelCall.sid, phone: dialablePhone },
          `📞 [RINGING] Exotel WSS carrier accepted call leg | Call SID: ${exotelCall.sid}`
        );
      } else {
        if (!env.SIP_OUTBOUND_TRUNK_ID) {
          throw new Error('Missing SIP_OUTBOUND_TRUNK_ID in environment. Check Exotel SIP trunk in .env');
        }

        logger.info({ callId, phone: dialablePhone, trunk: env.SIP_OUTBOUND_TRUNK_ID }, `📞 [DIALING CARRIER] Dials: ${dialablePhone} via Exotel SIP trunk`);
        const participant = await this.sipClient.createSipParticipant(
          env.SIP_OUTBOUND_TRUNK_ID,
          dialablePhone,
          roomName,
          {
            participantIdentity: `phone-${dialablePhone.replace(/[^0-9]/g, '')}`,
            participantName: safeLeadName || undefined,
            fromNumber: callerId,
            ringingTimeout: 65,      // Server-side SIP 65s ringing timeout enforced by LiveKit gateway
            maxCallDuration: 900,    // Server-side SIP 15-minute max call duration
            waitUntilAnswered: false,
          } as any
        );

        await query('UPDATE calls SET sip_call_id = $1 WHERE id = $2', [participant.sipCallId || null, callId]);
        logger.info({ callId, sipCallId: participant.sipCallId, phone: dialablePhone }, `📞 [RINGING] Carrier accepted call leg | SIP ID: ${participant.sipCallId || 'N/A'}`);
      }
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
IMPORTANT RULES:
- ONLY extract category ("residential" or "commercial") and intent ("sale" or "lease") if the CUSTOMER explicitly stated or confirmed them.
- If the customer never stated or confirmed whether it is residential or commercial, set "category": null.
- If the customer never stated or confirmed whether they want to sell or rent, set "intent": null.
- If the customer says they are not interested, no, or refused ("Nahi", "nahi ji", "not interested"), set "intent": null, "category": null, "immediate_occupancy": null, "is_currently_leased": null.
- DO NOT assume or guess based on what the agent asked.
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

    // Isolate customer turns to avoid falsely matching keywords from agent greeting/questions
    const customerTurns = turns.filter((t) => {
      const r = (t.role || '').toLowerCase();
      return r === 'customer' || r === 'user' || r === 'client' || r === 'speaker_1';
    });
    const customerText = customerTurns.map((t) => t.text || t.message || '').join(' ').toLowerCase();
    const isCustomerRefused = /nahi|nahi ji|not interested|dont want|don't want|mana|wrong number|wrong person|no thanks|never/i.test(customerText);

    // Owner Name: "मेरा नाम मयंक ओझा है" or "naam Mayank"
    if (!result.owner_name_confirmed) {
      const nameMatch = dialogueText.match(/(?:मेरा नाम(?: है)?|नाम है|name is|i am)\s+([A-Za-z\u0900-\u097F\s]{2,30}?)(?=[।.,\n]|$)/i);
      if (nameMatch && nameMatch[1]) {
        result.owner_name_confirmed = nameMatch[1].trim();
      }
    }

    // Commercial Type (Office Space, Retail Shop, Showroom, Warehouse, etc.) - Only if stated by customer or explicit in dialogue
    if (!result.commercial_type && !isCustomerRefused) {
      if (customerText.includes('office space') || customerText.includes('ऑफिस स्पेस') || customerText.includes('office')) {
        result.commercial_type = 'office space';
        result.category = 'commercial';
      } else if (customerText.includes('retail shop') || customerText.includes('shop') || customerText.includes('दुकान')) {
        result.commercial_type = 'retail shop';
        result.category = 'commercial';
      } else if (customerText.includes('showroom') || customerText.includes('शोरूम')) {
        result.commercial_type = 'showroom';
        result.category = 'commercial';
      } else if (customerText.includes('warehouse') || customerText.includes('godown') || customerText.includes('गोदाम')) {
        result.commercial_type = 'warehouse';
        result.category = 'commercial';
      }
    }

    // Category - ONLY from customer speech if not refused
    if (!result.category && !isCustomerRefused && customerText) {
      if (
        customerText.includes('कमर्शियल') ||
        customerText.includes('commercial') ||
        customerText.includes('office') ||
        customerText.includes('ऑफिस') ||
        customerText.includes('shop') ||
        customerText.includes('retail') ||
        customerText.includes('showroom') ||
        result.commercial_type
      ) {
        result.category = 'commercial';
      } else if (
        customerText.includes('रेजिडेंशियल') ||
        customerText.includes('रेसिडेंशियल') ||
        customerText.includes('residential') ||
        customerText.includes('flat') ||
        customerText.includes('bhk') ||
        customerText.includes('apartment')
      ) {
        result.category = 'residential';
      }
    }

    // Intent - ONLY if explicitly stated by customer (never inferred from agent's question)
    if (!result.intent && !isCustomerRefused && customerText) {
      if (
        customerText.includes('रेंट पर') ||
        customerText.includes('किराए पर') ||
        customerText.includes('rent par') ||
        customerText.includes('for rent') ||
        customerText.includes('lease par') ||
        customerText.includes('rent pe') ||
        customerText.includes('kiraye pe') ||
        customerText.includes('to rent') ||
        customerText.includes('for lease')
      ) {
        result.intent = 'lease';
      } else if (
        customerText.includes('सेल करना') ||
        customerText.includes('बेचना') ||
        customerText.includes('bechna') ||
        customerText.includes('sell karna') ||
        customerText.includes('for sale') ||
        customerText.includes('to sell')
      ) {
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

    if (result.category === 'commercial' || result.commercial_type || (result.project_or_society && /commercial|office|shop|retail|showroom|warehouse/i.test(result.project_or_society))) {
      result.category = 'commercial';
      result.bhk_config = undefined;
      result.commercial_type = result.commercial_type || 'Commercial Unit';
    } else if (result.category === 'residential' || result.bhk_config) {
      result.category = 'residential';
      result.commercial_type = undefined;
    }

    return result;
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

    // 2. Also ensure real_estate_outcomes records the turn incrementally
    const callRes = await query('SELECT re_lead_id FROM calls WHERE id = $1', [callId]);
    const leadId = callRes.rows[0]?.re_lead_id || null;

    await query(
      `INSERT INTO real_estate_outcomes (
         call_id, lead_id, final_disposition, transcript
       )
       VALUES ($1, $2, 'In Progress', $3::jsonb)
       ON CONFLICT (call_id)
       DO UPDATE SET
         transcript = COALESCE(real_estate_outcomes.transcript, '[]'::jsonb) || $3::jsonb`,
      [callId, leadId, JSON.stringify([turnObj])]
    );
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
    const isCommercial = Boolean(
      (data.commercial_type && !/residential/i.test(data.commercial_type)) ||
      (data.category && /comm|office|shop|retail|showroom|warehouse|godown|industrial|space|sco|booth/i.test(data.category)) ||
      (data.project_or_society && /commercial|office|shop|retail|showroom|warehouse|godown/i.test(data.project_or_society)) ||
      (data.sector_or_location && /commercial|office|shop|retail|showroom|warehouse|godown/i.test(data.sector_or_location)) ||
      (data.bhk_config && /office|shop|retail|showroom|commercial/i.test(data.bhk_config)) ||
      (data.agent_summary && /commercial|office space|retail shop|showroom|warehouse/i.test(data.agent_summary))
    );
    const isResidential = Boolean(
      data.bhk_config ||
      (data.category && /res|flat|apartment|house|villa|plot|kothi|bhk|studio|penthouse|floor/i.test(data.category))
    );

    if (isCommercial) {
      cleanCategory = 'commercial';
      data.bhk_config = undefined;
      if (!data.commercial_type || /residential/i.test(data.commercial_type)) {
        data.commercial_type = 'Commercial Unit';
      }
    } else if (isResidential) {
      cleanCategory = 'residential';
      data.commercial_type = undefined;
    } else if (data.category) {
      cleanCategory = data.category.toLowerCase().includes('comm') ? 'commercial' : (data.category.toLowerCase().includes('res') ? 'residential' : null);
    }

    let cleanIntent: string | null = null;
    if (data.intent) {
      cleanIntent = (data.intent.toLowerCase().includes('rent') || data.intent.toLowerCase().includes('lease')) ? 'lease' : (data.intent.toLowerCase().includes('sell') || data.intent.toLowerCase().includes('sale') ? 'sale' : null);
    }

    // If caller explicitly declined / not interested, do NOT keep any hallucinated intent, category or fake defaults
    const isCustomerNotInterested = data.is_interested === false || /not interested|do not call/i.test(data.final_disposition || '');
    if (isCustomerNotInterested) {
      if (!data.bhk_config && !data.commercial_type && !data.expected_sale_price && !data.expected_monthly_rent) {
        cleanIntent = null;
        cleanCategory = null;
      }
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
    const safeBhk = cleanCategory === 'commercial' ? null : (data.bhk_config ? cleanToEnglishOnly(data.bhk_config).slice(0, 64) : null);
    const safeCommercialType = cleanCategory === 'residential' ? null : (data.commercial_type ? cleanToEnglishOnly(data.commercial_type).slice(0, 64) : null);
    const safeFurnishing = data.furnishing_status ? cleanToEnglishOnly(data.furnishing_status).slice(0, 64) : null;
    const safePrice = data.expected_sale_price ? cleanToEnglishOnly(String(data.expected_sale_price)).slice(0, 128) : null;
    const safeRent = data.expected_monthly_rent ? cleanToEnglishOnly(String(data.expected_monthly_rent)).slice(0, 128) : null;
    const safeCurrentRent = data.current_rent_received ? cleanToEnglishOnly(String(data.current_rent_received)).slice(0, 128) : null;
    const safeOwnerConfirmed = data.owner_name_confirmed ? cleanToEnglishOnly(data.owner_name_confirmed).slice(0, 255) : null;

    if (hasPropertyInfo) {
      // Self-healing: ensure any existing records are consistently categorized
      query(`
        UPDATE real_estate_properties
        SET category = 'commercial', bhk_config = NULL
        WHERE (commercial_type IS NOT NULL OR LOWER(COALESCE(raw_notes, '')) LIKE '%commercial%' OR LOWER(COALESCE(raw_notes, '')) LIKE '%office%')
          AND (category != 'commercial' OR category IS NULL OR bhk_config IS NOT NULL)
      `).catch(() => {});

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
               bhk_config = CASE WHEN $1 = 'commercial' THEN NULL ELSE COALESCE($7, bhk_config) END,
               commercial_type = CASE WHEN $1 = 'residential' THEN NULL ELSE COALESCE($8, commercial_type) END,
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
            cleanCategory === 'commercial' ? null : safeBhk,
            cleanCategory === 'residential' ? null : safeCommercialType,
            cleanArea,
            safeFurnishing,
            safePrice,
            safeRent,
            cleanIsLeased,
            safeCurrentRent,
            cleanImmOcc,
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
      call.status,
      data.is_interested
    );

    // 3. Save real_estate_outcomes (ensure customer dialogue is saved in clean Romanized Hindi)
    const processedTranscript = data.transcript ? romanizeTranscript(data.transcript) : null;
    const transcriptJson = processedTranscript ? JSON.stringify(processedTranscript) : null;

    // Log the complete conversation in console
    if (processedTranscript && Array.isArray(processedTranscript) && processedTranscript.length > 0) {
      console.log(`\n======================================================================`);
      console.log(`  📞 REAL ESTATE CALL TRANSCRIPT (Call ID: ${callId})`);
      console.log(`  Owner: ${safeOwnerConfirmed || 'N/A'} | Disposition: ${canonicalDisp}`);
      console.log(`----------------------------------------------------------------------`);
      for (const turn of processedTranscript) {
        const isAgent = turn.role === 'assistant' || turn.role === 'agent';
        const speaker = isAgent ? '🤖 Priya   ' : '🗣️ Customer';
        console.log(`  ${speaker}: ${turn.text}`);
      }
      console.log(`======================================================================\n`);
    }

    const outcomeRes = await query(
      `INSERT INTO real_estate_outcomes (
         call_id, lead_id, property_id, final_disposition, is_interested,
         owner_name_confirmed, transcript, agent_summary, duration_seconds, median_latency_ms,
         language, initial_language, language_switched
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (call_id)
       DO UPDATE SET
         final_disposition = EXCLUDED.final_disposition,
         is_interested = EXCLUDED.is_interested,
         owner_name_confirmed = EXCLUDED.owner_name_confirmed,
         property_id = COALESCE(EXCLUDED.property_id, real_estate_outcomes.property_id),
         transcript = EXCLUDED.transcript,
         agent_summary = EXCLUDED.agent_summary,
         duration_seconds = EXCLUDED.duration_seconds,
         median_latency_ms = EXCLUDED.median_latency_ms,
         language = COALESCE(EXCLUDED.language, real_estate_outcomes.language),
         initial_language = COALESCE(EXCLUDED.initial_language, real_estate_outcomes.initial_language),
         language_switched = COALESCE(EXCLUDED.language_switched, real_estate_outcomes.language_switched)
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
        data.language || null,
        data.initial_language || null,
        data.language_switched ?? null,
      ]
    );

    // 4. Update call record status
    let mappedStatus = 'completed';
    let failureReason = (data as any).failure_reason || null;
    if (canonicalDisp === 'Not Connected (No Answer)') {
      mappedStatus = 'no_answer';
      failureReason = failureReason || 'Dialing timeout: callee did not answer within timeout period';
    } else if (canonicalDisp === 'Wrong Number') {
      mappedStatus = 'failed';
      failureReason = failureReason || 'Wrong Number';
    }

    await query(
      `UPDATE calls
       SET status = $1,
           call_status = $2,
           failure_reason = COALESCE($10, failure_reason),
           duration_seconds = GREATEST($3, COALESCE(duration_seconds, 0)),
           median_latency_ms = $4,
           answered_at = CASE WHEN $3 > 0 THEN COALESCE(answered_at, NOW() - ($3 || ' seconds')::interval) ELSE NULL END,
           ended_at = NOW(),
           language = COALESCE($6, language),
           initial_language = COALESCE($7, initial_language),
           language_switched = COALESCE($8, language_switched),
           recording_url = COALESCE($9, recording_url),
           recording_download_status = CASE WHEN $9 IS NOT NULL THEN 'done' ELSE recording_download_status END,
           recording_duration_seconds = COALESCE(recording_duration_seconds, $3)
       WHERE id = $5`,
      [
        mappedStatus,
        canonicalDisp,
        data.duration_seconds || 0,
        data.median_latency_ms || null,
        callId,
        data.language || null,
        data.initial_language || null,
        data.language_switched ?? null,
        data.recording_url || null,
        failureReason,
      ]
    );

    // 5. Update lead status if lead exists
    if (leadId) {
      // Keep the lead's starting language (not the mid-call switched one) so retries begin in the default/initial language.
      const leadLang = data.initial_language || data.language;
      if (leadLang) {
        await query(`UPDATE real_estate_leads SET preferred_language = $1 WHERE id = $2`, [leadLang, leadId]);
      }
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

    logger.info(
      {
        callId,
        owner: safeOwnerConfirmed || 'N/A',
        disposition: canonicalDisp,
        durationSeconds: data.duration_seconds || 0,
        recordingUrl: data.recording_url || null,
        propertyCategory: cleanCategory || 'N/A',
        propertyIntent: cleanIntent || 'N/A',
      },
      `📞 [CALL COMPLETED] ID: ${callId} | Disposition: ${canonicalDisp} | Duration: ${data.duration_seconds || 0}s | Recording: ${data.recording_url ? 'Available' : 'None'}`
    );

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
      // Periodic self-healing: fix category, BHK, and commercial type for any commercial calls
      await query(`
        UPDATE real_estate_properties
        SET category = 'commercial',
            bhk_config = NULL,
            commercial_type = COALESCE(
              NULLIF(commercial_type, 'residential'),
              CASE
                WHEN LOWER(COALESCE(project_or_society, '')) LIKE '%office%' THEN 'Office Space'
                WHEN LOWER(COALESCE(project_or_society, '')) LIKE '%shop%' THEN 'Retail Shop'
                WHEN LOWER(COALESCE(project_or_society, '')) LIKE '%showroom%' THEN 'Showroom'
                ELSE 'Commercial Unit'
              END
            )
        WHERE (
          LOWER(COALESCE(project_or_society, '')) LIKE '%commercial%' OR
          LOWER(COALESCE(project_or_society, '')) LIKE '%office%' OR
          LOWER(COALESCE(project_or_society, '')) LIKE '%shop%' OR
          LOWER(COALESCE(project_or_society, '')) LIKE '%retail%' OR
          LOWER(COALESCE(project_or_society, '')) LIKE '%showroom%' OR
          LOWER(COALESCE(project_or_society, '')) LIKE '%warehouse%'
        ) AND call_id NOT IN (
          SELECT call_id FROM real_estate_properties WHERE LOWER(COALESCE(raw_notes, '')) LIKE '%residential%' AND bhk_config IS NOT NULL
        )
      `).catch(() => {});

      // Only process orphaned outcomes that have NO property record at all (limit to 5)
      const candidates = await query(`
        SELECT c.id as call_id, ro.transcript, ro.property_id
        FROM calls c
        JOIN real_estate_outcomes ro ON c.id = ro.call_id
        LEFT JOIN real_estate_properties rp ON ro.property_id = rp.id
        WHERE c.pipeline = 'real_estate'
          AND ro.transcript IS NOT NULL
          AND rp.id IS NULL
        LIMIT 5
      `);

      for (const row of candidates.rows) {
        if (!row.transcript) continue;
        const extracted = await this.extractDetailsFromTranscript(row.transcript);
        if (extracted.project_or_society || extracted.sector_or_location || extracted.unit_number || extracted.category) {
          logger.info({ callId: row.call_id, extracted }, 'Backfilled missing property record for completed call');
          const newProp = await query(
            `INSERT INTO real_estate_properties (
               call_id, category, intent, project_or_society, sector_or_location,
               unit_number, floor_number, bhk_config, commercial_type, raw_notes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [
              row.call_id,
              extracted.category || null,
              extracted.intent || null,
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
            await query(`UPDATE real_estate_outcomes SET property_id = $1 WHERE call_id = $2`, [newProp.rows[0].id, row.call_id]).catch(() => {});
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
