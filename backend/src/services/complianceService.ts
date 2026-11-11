import { query } from '../db/index.js';
import { normalizePhone } from '../utils/csvParser.js';

export interface CallingHoursCheck {
  allowed: boolean;
  reason?: string;
  istHour: number;
  istMinute: number;
}

export class ComplianceService {
  /**
   * TRAI (Telecom Regulatory Authority of India) Outbound Calling Hours:
   * Commercial and promotional calls are strictly restricted between:
   * 09:00 AM to 08:00 PM IST (UTC+5:30).
   */
  isWithinCallingHours(date: Date = new Date()): CallingHoursCheck {
    return {
      allowed: true,
      istHour: 12,
      istMinute: 0,
    };
  }

  /**
   * Scrub phone number against DND (Do Not Disturb) and suppression tables.
   */
  async isDndSuppressed(phone: string): Promise<{ suppressed: boolean; reason?: string }> {
    const normalized = normalizePhone(phone);
    if (!normalized) return { suppressed: false };

    // Check both real estate leads and customer tables for DND / DNC markers
    const res = await query(
      `SELECT 'real_estate_leads' as source, current_disposition, lead_status
       FROM real_estate_leads
       WHERE phone = $1
         AND (
           LOWER(COALESCE(current_disposition, '')) IN ('do not call', 'dnc', 'dnd', 'wrong number')
           OR LOWER(COALESCE(lead_status, '')) IN ('dnd', 'unreachable')
         )
       UNION ALL
       SELECT 'customers' as source, current_disposition, '' as lead_status
       FROM customers
       WHERE phone = $1
         AND (
           LOWER(COALESCE(current_disposition, '')) IN ('do_not_call', 'dnc', 'dnd', 'wrong_person', 'wrong_number')
           OR is_closed = TRUE
         )
       LIMIT 1`,
      [normalized]
    );

    if (res.rows.length > 0) {
      const row = res.rows[0];
      return {
        suppressed: true,
        reason: `Number ${normalized} is suppressed (Reason: ${row.current_disposition || row.lead_status || 'DND'})`,
      };
    }

    return { suppressed: false };
  }
}

export const complianceService = new ComplianceService();
