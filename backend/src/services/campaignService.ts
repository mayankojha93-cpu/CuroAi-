import { pool } from '../db/index.js';
import { logger } from '../config/logger.js';

export type CampaignStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED' | 'Running' | 'Paused' | 'Completed' | 'Stopped';

export interface CampaignDbRow {
  id: string;
  name: string;
  description: string;
  status: string;
  service: string;
  progress_percent: number;
  total_contacts: number;
  unique_called: number;
  successful_calls: number;
  failed_calls: number;
  remaining_calls: number;
  credits_used: number;
  total_credits: number;
  execution_date: string;
  script?: string;
  language?: string;
  voice_pipeline?: string;
  schedule_start_time?: string;
  schedule_end_time?: string;
  operating_days?: string[];
  max_concurrent_calls?: number;
  calls_per_minute?: number;
  retry_attempts?: number;
  retry_delay_minutes?: number;
  max_call_duration_minutes?: number;
  expected_dispositions?: string[];
  created_at: string;
  updated_at: string;
}

function normalizePhoneNumber(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10) {
    return null; // Flagged: less than 10 digits
  }
  let cleaned = trimmed.replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+') && digits.length === 10) {
    cleaned = '+91' + digits;
  } else if (!cleaned.startsWith('+')) {
    cleaned = '+' + digits;
  }
  return cleaned;
}

export class CampaignService {
  /**
   * List all campaigns with optional status filter and search query
   */
  async listCampaigns(status?: string, search?: string): Promise<CampaignDbRow[]> {
    let query = `
      SELECT *
      FROM campaigns
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status && status !== 'ALL') {
      params.push(status.toUpperCase());
      query += ` AND UPPER(status) = $${params.length}`;
    }

    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      query += ` AND (LOWER(name) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`;
    }

    query += ` ORDER BY created_at DESC`;

    const res = await pool.query(query, params);
    return res.rows;
  }

  /**
   * Get single campaign by ID
   */
  async getCampaign(id: string): Promise<CampaignDbRow | null> {
    const res = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  /**
   * Create a new campaign with optional contacts deduplication and customer import
   */
  async createCampaign(data: {
    name: string;
    description?: string;
    status?: string;
    script?: string;
    language?: string;
    voice_pipeline?: string;
    schedule_start_time?: string;
    schedule_end_time?: string;
    operating_days?: string[];
    max_concurrent_calls?: number;
    calls_per_minute?: number;
    retry_attempts?: number;
    retry_delay_minutes?: number;
    max_call_duration_minutes?: number;
    expected_dispositions?: string[];
    total_contacts?: number;
    total_credits?: number;
    contacts?: string[];
  }): Promise<CampaignDbRow> {
    const status = (data.status || 'RUNNING').toUpperCase();
    
    // Deduplicate phone numbers and discard any < 10 digits
    const rawList = Array.isArray(data.contacts) ? data.contacts : [];
    const uniquePhones: string[] = [];
    const seen = new Set<string>();

    for (const raw of rawList) {
      const norm = normalizePhoneNumber(raw);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        uniquePhones.push(norm);
      }
    }

    const totalContacts = uniquePhones.length > 0 ? uniquePhones.length : (data.total_contacts || 0);
    const totalCredits = data.total_credits || totalContacts;

    const query = `
      INSERT INTO campaigns (
        name, description, status, total_contacts, total_credits, remaining_calls,
        script, language, voice_pipeline, schedule_start_time, schedule_end_time,
        operating_days, max_concurrent_calls, calls_per_minute, retry_attempts,
        retry_delay_minutes, max_call_duration_minutes, expected_dispositions
      )
      VALUES ($1, $2, $3, $4, $5, $4, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `;
    const res = await pool.query(query, [
      data.name,
      data.description || null,
      status,
      totalContacts,
      totalCredits,
      data.script || 'नमस्ते, मैं प्रिया बोल रही हूँ, एयरटेल की तरफ से। क्या मैं आपसे बात कर सकती हूँ?',
      data.language || 'hi-IN',
      data.voice_pipeline || 'Sarvam AI (Priya - hi-IN)',
      data.schedule_start_time || '09:00',
      data.schedule_end_time || '20:00',
      JSON.stringify(data.operating_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']),
      data.max_concurrent_calls || 5,
      data.calls_per_minute || 30,
      data.retry_attempts || 3,
      data.retry_delay_minutes || 180,
      data.max_call_duration_minutes || 5,
      JSON.stringify(data.expected_dispositions || [
        'CONFIRMED_PICKUP',
        'NEEDS_AIRTEL_SUPPORT',
        'SCHEDULE_CALLBACK',
        'REFUSED',
        'WRONG_PERSON',
      ]),
    ]);
    const campaign = res.rows[0];

    // Insert deduplicated contacts linked to this campaign
    if (uniquePhones.length > 0) {
      for (const phone of uniquePhones) {
        try {
          await pool.query(
            `INSERT INTO customers (
               name, phone, address, language, total_attempts, max_attempts, next_attempt_time, campaign_id
             )
             VALUES ($1, $2, 'Address On Record', 'hi', 0, 3, NOW(), $3)
             ON CONFLICT (phone)
             DO UPDATE SET campaign_id = EXCLUDED.campaign_id`,
            [`Contact ${phone.slice(-4)}`, phone, campaign.id]
          );
        } catch (err) {
          logger.warn({ phone, err }, 'Failed to insert customer lead for campaign');
        }
      }
    }

    logger.info({ campaignId: campaign.id, name: data.name, contactsCount: totalContacts }, 'Created new voice campaign');
    return campaign;
  }

  /**
   * Update campaign status between: RUNNING, PAUSED, COMPLETED, STOPPED
   */
  async updateCampaignStatus(id: string, status: string): Promise<CampaignDbRow> {
    const normalized = status.toUpperCase();
    if (!['RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED'].includes(normalized)) {
      throw new Error(`Invalid status: ${status}. Must be RUNNING, PAUSED, COMPLETED, or STOPPED.`);
    }

    const query = `
      UPDATE campaigns
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `;
    const res = await pool.query(query, [normalized, id]);
    if (res.rows.length === 0) {
      throw new Error(`Campaign not found with ID: ${id}`);
    }
    logger.info({ campaignId: id, status: normalized }, 'Updated campaign status');
    return res.rows[0];
  }

  /**
   * Delete or archive a campaign
   */
  async deleteCampaign(id: string): Promise<boolean> {
    const res = await pool.query('DELETE FROM campaigns WHERE id = $1 RETURNING id', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Get calls belonging to a specific campaign
   */
  async getCampaignCalls(campaignId: string): Promise<any[]> {
    const res = await pool.query(
      `SELECT 
         c.id,
         c.customer_id,
         c.campaign_id,
         c.status,
         c.room_name,
         c.duration_seconds,
         c.created_at,
         cu.name as customer_name,
         cu.phone as customer_phone,
         cu.subs_del_no as contact_ref,
         cu.language as customer_language,
         co.outcome as call_outcome,
         co.final_disposition as call_result,
         co.transcript
       FROM calls c
       LEFT JOIN customers cu ON c.customer_id = cu.id
       LEFT JOIN call_outcomes co ON c.id = co.call_id
       WHERE c.campaign_id = $1
       ORDER BY c.created_at DESC
       LIMIT 100`,
      [campaignId]
    );
    return res.rows;
  }
}

export const campaignService = new CampaignService();
