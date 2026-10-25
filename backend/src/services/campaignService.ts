import { pool } from '../db/index.js';
import { logger } from '../config/logger.js';
import { callService } from './callService.js';
import {
  CANONICAL_DISPOSITIONS,
  TERMINAL_DISPOSITIONS,
  matchCanonicalDisposition,
} from '../utils/dispositions.js';

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
  total_talk_time_seconds?: number;
  avg_duration_seconds?: number;
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
      SELECT 
        c.*,
        COALESCE(cs.total_talk_time_seconds, 0)::INT as total_talk_time_seconds,
        COALESCE(cs.avg_duration_seconds, 0)::INT as avg_duration_seconds
      FROM campaigns c
      LEFT JOIN (
        SELECT 
          campaign_id,
          SUM(COALESCE(duration_seconds, 0))::INT as total_talk_time_seconds,
          CASE 
            WHEN COUNT(CASE WHEN duration_seconds > 0 THEN 1 END) > 0 
            THEN ROUND(SUM(COALESCE(duration_seconds, 0))::DECIMAL / COUNT(CASE WHEN duration_seconds > 0 THEN 1 END))::INT
            ELSE 0 
          END as avg_duration_seconds
        FROM calls
        GROUP BY campaign_id
      ) cs ON c.id = cs.campaign_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status && status !== 'ALL') {
      params.push(status.toUpperCase());
      query += ` AND UPPER(c.status) = $${params.length}`;
    }

    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      query += ` AND (LOWER(c.name) LIKE $${params.length} OR LOWER(c.description) LIKE $${params.length})`;
    }

    query += ` ORDER BY c.created_at DESC`;

    const res = await pool.query(query, params);
    return res.rows;
  }

  /**
   * Get single campaign by ID
   */
  async getCampaign(id: string): Promise<CampaignDbRow | null> {
    const query = `
      SELECT 
        c.*,
        COALESCE(cs.total_talk_time_seconds, 0)::INT as total_talk_time_seconds,
        COALESCE(cs.avg_duration_seconds, 0)::INT as avg_duration_seconds
      FROM campaigns c
      LEFT JOIN (
        SELECT 
          campaign_id,
          SUM(COALESCE(duration_seconds, 0))::INT as total_talk_time_seconds,
          CASE 
            WHEN COUNT(CASE WHEN duration_seconds > 0 THEN 1 END) > 0 
            THEN ROUND(SUM(COALESCE(duration_seconds, 0))::DECIMAL / COUNT(CASE WHEN duration_seconds > 0 THEN 1 END))::INT
            ELSE 0 
          END as avg_duration_seconds
        FROM calls
        GROUP BY campaign_id
      ) cs ON c.id = cs.campaign_id
      WHERE c.id = $1
    `;
    const res = await pool.query(query, [id]);
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
    const totalCredits = data.total_credits !== undefined && data.total_credits !== null ? Number(data.total_credits) : totalContacts;
    const retryAttempts = data.retry_attempts !== undefined && data.retry_attempts !== null ? Number(data.retry_attempts) : 3;
    const retryDelayMinutes = data.retry_delay_minutes !== undefined && data.retry_delay_minutes !== null ? Number(data.retry_delay_minutes) : 180;
    const maxConcurrent = data.max_concurrent_calls !== undefined && data.max_concurrent_calls !== null ? Number(data.max_concurrent_calls) : 5;
    const callsPerMin = data.calls_per_minute !== undefined && data.calls_per_minute !== null ? Number(data.calls_per_minute) : 30;
    const maxDuration = data.max_call_duration_minutes !== undefined && data.max_call_duration_minutes !== null ? Number(data.max_call_duration_minutes) : 5;

    const query = `
      INSERT INTO campaigns (
        name, description, status, total_contacts, total_credits, remaining_calls,
        script, language, voice_pipeline, schedule_start_time, schedule_end_time,
        operating_days, max_concurrent_calls, calls_per_minute, retry_attempts,
        retry_delay_minutes, max_call_duration_minutes, expected_dispositions
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *
    `;
    const res = await pool.query(query, [
      data.name.trim(),
      data.description?.trim() || null,
      status,
      totalContacts,
      totalCredits,
      totalContacts, // initial remaining_calls
      data.script || 'Airtel Delhi Wi-Fi (Routine Pickup)',
      data.language || 'hi-IN',
      data.voice_pipeline || 'Sarvam AI (Priya - hi-IN)',
      data.schedule_start_time || '09:00',
      data.schedule_end_time || '20:00',
      JSON.stringify(data.operating_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']),
      maxConcurrent,
      callsPerMin,
      retryAttempts,
      retryDelayMinutes,
      maxDuration,
      JSON.stringify(data.expected_dispositions || CANONICAL_DISPOSITIONS),
    ]);
    const campaign = res.rows[0];

    // Insert deduplicated contacts linked to this campaign
    if (uniquePhones.length > 0) {
      const custLang = data.language ? data.language.slice(0, 2).toLowerCase() : 'hi';
      for (const phone of uniquePhones) {
        try {
          await pool.query(
            `INSERT INTO customers (
               name, phone, address, language, total_attempts, max_attempts, next_attempt_time, campaign_id
             )
             VALUES ($1, $2, 'Address On Record', $3, 0, $4, NOW(), $5)
             ON CONFLICT (phone)
             DO UPDATE SET campaign_id = EXCLUDED.campaign_id, max_attempts = EXCLUDED.max_attempts`,
            [`Contact ${phone.slice(-4)}`, phone, custLang, retryAttempts, campaign.id]
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
   * Update campaign retry settings (attempts and delay) and sync customer contacts
   */
  async updateCampaignRetry(
    campaignId: string,
    retryAttempts: number,
    retryDelayMinutes?: number
  ): Promise<{ campaign: CampaignDbRow; eligibleForRetryCount: number }> {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const attempts = Math.max(1, Math.min(10, Math.floor(retryAttempts)));
    const delay = retryDelayMinutes && retryDelayMinutes > 0 ? Math.floor(retryDelayMinutes) : (campaign.retry_delay_minutes || 180);

    const updRes = await pool.query(
      `UPDATE campaigns
       SET retry_attempts = $1,
           retry_delay_minutes = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [attempts, delay, campaignId]
    );

    // Terminal dispositions that should remain closed
    const terminalList = [
      ...TERMINAL_DISPOSITIONS,
      'CONFIRMED_FOR_PICKUP', 'PICKUP_CONFIRMED', 'PICKUP_CONFIRMED_NEW_DATE',
      'REFUSED_TO_RETURN', 'PICKUP_DECLINED', 'ALREADY_RETURNED', 'ALREADY_PICKED_UP',
      'REFUND_REQUEST', 'REFUND_OR_OWNERSHIP_QUERY', 'RECHARGED_DEVICE', 'ALREADY_RECHARGED',
      'DAMAGED_DEVICE', 'LOST_DEVICE', 'WRONG_NUMBER', 'WRONG_NUMBER_OR_IDENTITY_NOT_CONFIRMED',
      'DO_NOT_CALL', 'COMPLAINT_ESCALATION', 'NEEDS_AIRTEL_SUPPORT', 'SHIFTED_DEVICE_WITH_CUSTOMER',
      'Goal completed', 'CONFIRMED_PICKUP'
    ];

    // Update customer contacts belonging to this campaign:
    // Update max_attempts, reopen contacts if total_attempts < new attempts and not terminal
    const reopenRes = await pool.query(
      `UPDATE customers
       SET max_attempts = $1,
           is_closed = CASE
             WHEN current_disposition = ANY($2::text[]) THEN TRUE
             WHEN total_attempts >= $1 THEN TRUE
             ELSE FALSE
           END,
           next_attempt_time = CASE
             WHEN total_attempts < $1 AND (current_disposition IS NULL OR NOT (current_disposition = ANY($2::text[])))
             THEN NOW()
             ELSE next_attempt_time
           END
       WHERE campaign_id = $3
          OR id IN (SELECT customer_id FROM calls WHERE campaign_id = $3)
       RETURNING id, is_closed, total_attempts`,
      [attempts, terminalList, campaignId]
    );

    const eligibleForRetryCount = reopenRes.rows.filter(
      (r) => !r.is_closed && Number(r.total_attempts) < attempts
    ).length;

    // Recalculate remaining calls on campaign
    await pool.query(
      `UPDATE campaigns
       SET remaining_calls = (
         SELECT COUNT(*)::int
         FROM customers
         WHERE (campaign_id = $1 OR id IN (SELECT customer_id FROM calls WHERE campaign_id = $1))
           AND is_closed = FALSE
           AND total_attempts < $2
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [campaignId, attempts]
    );

    const finalCampRes = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);

    logger.info(
      { campaignId, retryAttempts: attempts, retryDelayMinutes: delay, eligibleForRetryCount },
      'Updated campaign retry settings and synced contacts'
    );

    return {
      campaign: finalCampRes.rows[0],
      eligibleForRetryCount,
    };
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
         COALESCE(co.final_disposition, c.call_status, cu.current_disposition, c.status) as call_result,
         co.transcript
       FROM calls c
       LEFT JOIN customers cu ON c.customer_id = cu.id
       LEFT JOIN call_outcomes co ON c.id = co.call_id
       WHERE c.campaign_id = $1 OR cu.campaign_id = $1
       ORDER BY c.created_at DESC
       LIMIT 100`,
      [campaignId]
    );
    return res.rows.map((row: any) => {
      const canonical = row.call_result
        ? matchCanonicalDisposition(row.call_result, row.duration_seconds, row.status)
        : null;
      return {
        ...row,
        call_result: canonical || row.call_result,
        final_disposition: canonical,
      };
    });
  }

  /**
   * Get all target audience contacts for a campaign with their attempts, latest call status, duration, disposition, and timestamp
   */
  async getCampaignContacts(campaignId: string): Promise<any[]> {
    const query = `
      SELECT 
        cu.id as contact_id,
        cu.name as contact_name,
        cu.phone as contact_phone,
        cu.subs_del_no as contact_ref,
        cu.language,
        COALESCE(GREATEST(cu.total_attempts, call_counts.count), 0)::INT as attempts,
        cu.max_attempts,
        cu.current_disposition,
        cu.created_at as contact_created_at,
        latest_call.id as last_call_id,
        latest_call.status as call_status,
        latest_call.duration_seconds,
        latest_call.created_at as last_called_at,
        latest_call.recording_url,
        latest_call.final_disposition,
        latest_call.call_outcome
      FROM customers cu
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INT as count 
        FROM calls 
        WHERE customer_id = cu.id
      ) call_counts ON true
      LEFT JOIN LATERAL (
        SELECT 
          c.id,
          c.status,
          c.duration_seconds,
          c.created_at,
          c.recording_url,
          co.outcome as call_outcome,
          co.final_disposition
        FROM calls c
        LEFT JOIN call_outcomes co ON c.id = co.call_id
        WHERE c.customer_id = cu.id
        ORDER BY c.created_at DESC
        LIMIT 1
      ) latest_call ON true
      WHERE cu.campaign_id = $1 
         OR cu.id IN (SELECT customer_id FROM calls WHERE campaign_id = $1)
      ORDER BY COALESCE(latest_call.created_at, cu.created_at) DESC
      LIMIT 500
    `;
    const res = await pool.query(query, [campaignId]);
    return res.rows.map((row: any) => ({
      ...row,
      final_disposition: row.final_disposition || row.current_disposition
        ? matchCanonicalDisposition(row.final_disposition || row.current_disposition, row.duration_seconds, row.call_status)
        : null,
      current_disposition: row.current_disposition
        ? matchCanonicalDisposition(row.current_disposition)
        : null,
    }));
  }

  /**
   * Start campaign and dispatch pending calls according to rate limits and schedule.
   */
  async startCampaign(campaignId: string): Promise<{ campaign: CampaignDbRow; dispatchedCount: number }> {
    const campaign = await this.updateCampaignStatus(campaignId, 'RUNNING');
    const maxConcurrent = campaign.max_concurrent_calls || 5;

    // Check currently active calls for this campaign
    const activeRes = await pool.query(
      `SELECT COUNT(*)::int as active_count
       FROM calls
       WHERE campaign_id = $1
         AND status IN ('initiated', 'dialing', 'answered')
         AND created_at > NOW() - INTERVAL '10 minutes'`,
      [campaignId]
    );
    const activeCount = activeRes.rows[0]?.active_count || 0;
    const availableSlots = Math.max(0, maxConcurrent - activeCount);

    let dispatchedCount = 0;
    if (availableSlots > 0) {
      const pendingCustomers = await pool.query(
        `SELECT * FROM customers
         WHERE campaign_id = $1
           AND is_closed = FALSE
           AND (next_attempt_time IS NULL OR next_attempt_time <= NOW())
         ORDER BY total_attempts ASC, created_at ASC
         LIMIT $2`,
        [campaignId, availableSlots]
      );

      for (const cust of pendingCustomers.rows) {
        try {
          await callService.initiateCall(cust.id);
          dispatchedCount++;
        } catch (err) {
          logger.warn({ customerId: cust.id, err }, 'Failed to initiate campaign call for customer');
        }
      }
    }

    logger.info({ campaignId, dispatchedCount, activeCount, maxConcurrent }, 'Campaign start triggered');
    return { campaign, dispatchedCount };
  }

  /**
   * Add contacts to an existing campaign from CSV upload.
   */
  async addContactsToCampaign(
    campaignId: string,
    contacts: (string | { phone: string; name?: string; email?: string })[]
  ): Promise<{ campaign: CampaignDbRow; addedCount: number; duplicatesCount: number; invalidCount: number }> {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const validPhones: { phone: string; name?: string }[] = [];
    const seen = new Set<string>();
    let invalidCount = 0;
    let duplicatesCount = 0;

    for (const item of contacts) {
      const rawPhone = typeof item === 'string' ? item : item.phone;
      const rawName = typeof item === 'object' ? item.name : undefined;
      const norm = normalizePhoneNumber(rawPhone);

      if (!norm) {
        invalidCount++;
        continue;
      }
      if (seen.has(norm)) {
        duplicatesCount++;
        continue;
      }
      seen.add(norm);
      validPhones.push({ phone: norm, name: rawName });
    }

    const retryAttempts = campaign.retry_attempts || 3;
    const custLang = campaign.language ? campaign.language.slice(0, 2).toLowerCase() : 'hi';
    let addedCount = 0;

    for (const entry of validPhones) {
      try {
        const ins = await pool.query(
          `INSERT INTO customers (
             name, phone, address, language, total_attempts, max_attempts, next_attempt_time, campaign_id
           )
           VALUES ($1, $2, 'Address On Record', $3, 0, $4, NOW(), $5)
           ON CONFLICT (phone)
           DO UPDATE SET campaign_id = EXCLUDED.campaign_id, max_attempts = EXCLUDED.max_attempts
           RETURNING id`,
          [entry.name || `Contact ${entry.phone.slice(-4)}`, entry.phone, custLang, retryAttempts, campaignId]
        );
        if (ins.rows.length > 0) {
          addedCount++;
        }
      } catch (err) {
        logger.warn({ phone: entry.phone, err }, 'Failed to insert customer lead for campaign');
      }
    }

    const upd = await pool.query(
      `UPDATE campaigns
       SET total_contacts = total_contacts + $1,
           remaining_calls = remaining_calls + $1,
           total_credits = total_credits + $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [addedCount, campaignId]
    );

    logger.info({ campaignId, addedCount, duplicatesCount, invalidCount }, 'Added contacts to campaign');
    return {
      campaign: upd.rows[0],
      addedCount,
      duplicatesCount,
      invalidCount,
    };
  }

  /**
   * Generate per-lead report data for CSV download.
   * Returns: S.No, Lead Id, SUBS DEL NO, Mobile, Customer Name, Product Name, Address,
   *          Status, Attempts Count, Connected Attempts Count, Last Call Time,
   *          Attempt 1-8 Disposition, Final Disposition, Conclusion Date, Recording
   */
  async getCampaignReport(campaignId: string): Promise<any[]> {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    // Fetch all leads for this campaign with all their call attempts
    const query = `
      SELECT
        cu.id as lead_id,
        cu.subs_del_no,
        cu.phone as mobile,
        cu.name as customer_name,
        cu.product_name,
        cu.address,
        cu.is_closed,
        cu.current_disposition,
        cu.total_attempts,
        cu.created_at as lead_created_at
      FROM customers cu
      WHERE cu.campaign_id = $1
         OR cu.id IN (SELECT customer_id FROM calls WHERE campaign_id = $1)
      ORDER BY cu.created_at ASC
    `;
    const leadsRes = await pool.query(query, [campaignId]);

    const reportRows: any[] = [];

    for (let idx = 0; idx < leadsRes.rows.length; idx++) {
      const lead = leadsRes.rows[idx];

      // Fetch all call attempts for this lead, ordered by attempt number / created_at
      const callsQuery = `
        SELECT
          c.id as call_id,
          c.attempt_number,
          c.status as call_status,
          c.duration_seconds,
          c.created_at as call_time,
          c.recording_url,
          c.ended_at,
          COALESCE(co.final_disposition, c.call_status, c.status) as disposition,
          co.final_disposition as outcome_disposition
        FROM calls c
        LEFT JOIN call_outcomes co ON c.id = co.call_id
        WHERE c.customer_id = $1
        ORDER BY c.created_at ASC
      `;
      const callsRes = await pool.query(callsQuery, [lead.lead_id]);
      const calls = callsRes.rows;

      // Build attempt dispositions (up to 8)
      const attemptDispositions: (string | null)[] = Array(8).fill(null);
      let connectedCount = 0;
      let lastCallTime: string | null = null;
      let lastRecordingUrl: string | null = null;
      let finalDisposition: string | null = lead.current_disposition || null;
      let conclusionDate: string | null = null;

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        // Map to attempt index (0-based for array, but attempt_number is 1-based)
        const attemptIdx = i < 8 ? i : 7; // Cap at 8 attempts
        const rawDisp = call.outcome_disposition || call.disposition || call.call_status || '';
        const canonical = rawDisp ? matchCanonicalDisposition(rawDisp, call.duration_seconds, call.call_status) : '';
        attemptDispositions[attemptIdx] = canonical || rawDisp || null;

        // Count connected attempts (answered / completed with duration > 0)
        const status = (call.call_status || call.disposition || '').toUpperCase();
        if (
          status === 'ANSWERED' ||
          status === 'COMPLETED' ||
          (call.duration_seconds && call.duration_seconds > 0)
        ) {
          connectedCount++;
        }

        // Track last call time
        if (call.call_time) {
          lastCallTime = call.call_time;
        }

        // Track recording URL (use the latest one available)
        if (call.recording_url) {
          lastRecordingUrl = call.recording_url;
        }

        // Final disposition = last call's disposition
        if (i === calls.length - 1) {
          finalDisposition = canonical || rawDisp || lead.current_disposition || null;
          // Conclusion date = ended_at of last call if lead is closed
          if (lead.is_closed && call.ended_at) {
            conclusionDate = call.ended_at;
          } else if (lead.is_closed && call.call_time) {
            conclusionDate = call.call_time;
          }
        }
      }

      // Determine status
      let leadStatus = 'Pending';
      if (lead.is_closed) {
        leadStatus = 'Closed';
      } else if (calls.length > 0) {
        leadStatus = 'In Progress';
      }

      const attemptsCount = Math.max(lead.total_attempts || 0, calls.length);

      reportRows.push({
        sno: idx + 1,
        lead_id: lead.lead_id,
        subs_del_no: lead.subs_del_no || '',
        mobile: lead.mobile || '',
        customer_name: lead.customer_name || '',
        product_name: lead.product_name || 'Airtel IP TV',
        address: lead.address || '',
        status: leadStatus,
        attempts_count: attemptsCount,
        connected_attempts_count: connectedCount,
        last_call_time: lastCallTime || '',
        attempt_1_disposition: attemptDispositions[0] || '',
        attempt_2_disposition: attemptDispositions[1] || '',
        attempt_3_disposition: attemptDispositions[2] || '',
        attempt_4_disposition: attemptDispositions[3] || '',
        attempt_5_disposition: attemptDispositions[4] || '',
        attempt_6_disposition: attemptDispositions[5] || '',
        attempt_7_disposition: attemptDispositions[6] || '',
        attempt_8_disposition: attemptDispositions[7] || '',
        final_disposition: finalDisposition ? matchCanonicalDisposition(finalDisposition) : '',
        conclusion_date: conclusionDate || '',
        recording: lastRecordingUrl || '',
      });
    }

    return reportRows;
  }

  /**
   * Get disposition breakdown for a campaign
   */
  async getCampaignDispositions(campaignId: string): Promise<{
    expected: string[];
    dispositions: { name: string; count: number; percentage: number }[];
    totalCalls: number;
  }> {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const query = `
      WITH call_disps AS (
        SELECT 
          COALESCE(
            NULLIF(TRIM(co.final_disposition), ''),
            NULLIF(TRIM(c.call_status), ''),
            NULLIF(TRIM(cu.current_disposition), ''),
            NULLIF(TRIM(c.status), '')
          ) as disposition
        FROM calls c
        LEFT JOIN customers cu ON c.customer_id = cu.id
        LEFT JOIN call_outcomes co ON c.id = co.call_id
        WHERE c.campaign_id = $1 OR cu.campaign_id = $1
      ),
      cust_disps AS (
        SELECT 
          NULLIF(TRIM(cu.current_disposition), '') as disposition
        FROM customers cu
        WHERE cu.campaign_id = $1
          AND cu.current_disposition IS NOT NULL
          AND cu.id NOT IN (
            SELECT DISTINCT customer_id FROM calls WHERE customer_id IS NOT NULL AND (campaign_id = $1 OR customer_id IN (SELECT id FROM customers WHERE campaign_id = $1))
          )
      ),
      all_disps AS (
        SELECT disposition FROM call_disps WHERE disposition IS NOT NULL
        UNION ALL
        SELECT disposition FROM cust_disps WHERE disposition IS NOT NULL
      )
      SELECT disposition, COUNT(*)::int as count
      FROM all_disps
      GROUP BY 1
      ORDER BY count DESC
    `;

    const res = await pool.query(query, [campaignId]);

    const totalRes = await pool.query(
      `SELECT COUNT(*)::int as total 
       FROM calls c
       LEFT JOIN customers cu ON c.customer_id = cu.id
       WHERE c.campaign_id = $1 OR cu.campaign_id = $1`,
      [campaignId]
    );
    let totalCalls = totalRes.rows[0]?.total || 0;

    const expected: string[] = Array.isArray(campaign.expected_dispositions) && campaign.expected_dispositions.length > 0
      ? campaign.expected_dispositions.map((e) => matchCanonicalDisposition(e))
      : [...CANONICAL_DISPOSITIONS];

    const dispMap = new Map<string, number>();

    // Seed all 14 canonical dispositions with 0
    CANONICAL_DISPOSITIONS.forEach((d) => dispMap.set(d, 0));

    // Fill with actual call counts mapped to canonical 14
    res.rows.forEach((row) => {
      const canonicalName = matchCanonicalDisposition(row.disposition);
      dispMap.set(canonicalName, (dispMap.get(canonicalName) || 0) + Number(row.count));
    });

    const totalDispositionsCount = Array.from(dispMap.values()).reduce((sum, c) => sum + c, 0);
    const denominator = totalCalls > 0 ? totalCalls : totalDispositionsCount;

    const dispositions = Array.from(dispMap.entries())
      .map(([name, count]) => ({
        name,
        count,
        percentage: denominator > 0 ? Math.round((count / denominator) * 100) : 0,
      }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });

    return {
      expected,
      dispositions,
      totalCalls: Math.max(totalCalls, totalDispositionsCount),
    };
  }
}

export const campaignService = new CampaignService();
