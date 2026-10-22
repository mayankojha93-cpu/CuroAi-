/**
 * Utilities for parsing CSV telecom leads, normalizing phone numbers, and parsing dates.
 */

export interface ParsedTelecomLead {
  name?: string;
  phone?: string;
  address: string;
  language?: string;
  account_no?: string;
  subs_del_no?: string;
  service_end_date?: string;
  r_date?: string;
  check?: string;
}

/**
 * Normalizes dates from various formats to SQL standard YYYY-MM-DD.
 * Handles:
 * - "29 Aug 26" -> "2026-08-29"
 * - "27 Aug 2026" -> "2026-08-27"
 * - "29/08/2026" -> "2026-08-29"
 * - "2026-08-29" -> "2026-08-29"
 */
export function normalizeDate(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const str = raw.trim();

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // Format: "29 Aug 26" or "29-Aug-2026" or "29 Aug 2026"
  const wordMonthMatch = str.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2,4})$/);
  if (wordMonthMatch) {
    const day = parseInt(wordMonthMatch[1], 10);
    const monthStr = wordMonthMatch[2].toLowerCase().slice(0, 3);
    let year = parseInt(wordMonthMatch[3], 10);
    if (year < 100) year += 2000;

    const months: Record<string, number> = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };

    const month = months[monthStr];
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Format: "DD/MM/YYYY" or "DD-MM-YYYY"
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    let year = parseInt(dmyMatch[3], 10);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Fallback to Date parser
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return null;
}

/**
 * Normalizes phone numbers to Indian E.164 (+91...)
 * If explicit phone is missing, extracts from subs_del_no (e.g. "01121344121_wifi" -> "+911121344121").
 */
export function normalizePhone(phone?: string | null, subsDelNo?: string | null): string {
  let candidate = (phone || '').trim();

  if (!candidate && subsDelNo) {
    // Strip suffixes like _wifi, _broadband, _dsl, _ftth
    candidate = subsDelNo.replace(/_(wifi|broadband|dsl|ftth|airtel)/gi, '').trim();
  }

  const hasPlus = candidate.startsWith('+');
  const digits = candidate.replace(/\D/g, '');

  if (hasPlus && digits.length >= 10) {
    return `+${digits}`;
  }

  // If starts with 91 and has 12 digits (e.g. 919811122233)
  if (digits.startsWith('91') && digits.length === 12) {
    return `+${digits}`;
  }

  // If starts with 0 and has 11 digits (e.g. 01121344121 for Delhi landline)
  if (digits.startsWith('0') && digits.length === 11) {
    return `+91${digits.slice(1)}`;
  }

  // If 10 digits (mobile or local number)
  if (digits.length === 10) {
    return `+91${digits}`;
  }

  if (digits.length >= 8) {
    return `+91${digits}`;
  }

  return candidate || '+910000000000';
}

/**
 * Parses raw CSV lines handling quoted cells and trims whitespace.
 */
export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  const lines = csvText.split(/\r\n|\n|\r/);

  for (const line of lines) {
    if (!line.trim()) continue;

    const row: string[] = [];
    let insideQuotes = false;
    let currentCell = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') {
          currentCell += '"';
          i++; // skip escaped quote
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        row.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    row.push(currentCell.trim());
    if (row.length > 0 && row.some(cell => cell.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Maps CSV headers to lead fields flexibly:
 * Supports columns from sample:
 * "R. Date", "Check", "SUBS_DEL_NO", "ACCOUNT_NO", "SERVICE_END", "Address"
 */
export function parseCsvToLeads(csvText: string): ParsedTelecomLead[] {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[\s\._\-]/g, ''));
  const headerMap: Record<string, number> = {};

  headers.forEach((header, index) => {
    if (header.includes('rdate') || header === 'rdate' || header === 'date') {
      headerMap['r_date'] = index;
    } else if (header.includes('subsdel') || header.includes('subscriber') || header === 'wifiid') {
      headerMap['subs_del_no'] = index;
    } else if (header.includes('account') || header.includes('accno')) {
      headerMap['account_no'] = index;
    } else if (header.includes('serviceend') || header.includes('enddate') || header === 'serviceend') {
      headerMap['service_end_date'] = index;
    } else if (header.includes('address') || header.includes('addr')) {
      headerMap['address'] = index;
    } else if (header.includes('phone') || header.includes('mobile') || header.includes('contact')) {
      headerMap['phone'] = index;
    } else if (header.includes('name') || header.includes('customer')) {
      headerMap['name'] = index;
    } else if (header.includes('check')) {
      headerMap['check'] = index;
    }
  });

  const leads: ParsedTelecomLead[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const subsDelNo = headerMap['subs_del_no'] !== undefined ? row[headerMap['subs_del_no']] : '';
    const accountNo = headerMap['account_no'] !== undefined ? row[headerMap['account_no']] : '';
    const rawAddress = headerMap['address'] !== undefined ? row[headerMap['address']] : '';
    const rawPhone = headerMap['phone'] !== undefined ? row[headerMap['phone']] : '';
    const rawName = headerMap['name'] !== undefined ? row[headerMap['name']] : '';
    const rawRDate = headerMap['r_date'] !== undefined ? row[headerMap['r_date']] : '';
    const rawServiceEnd = headerMap['service_end_date'] !== undefined ? row[headerMap['service_end_date']] : '';
    const rawCheck = headerMap['check'] !== undefined ? row[headerMap['check']] : '';

    if (!subsDelNo && !accountNo && !rawAddress && !rawPhone) {
      continue;
    }

    const phone = normalizePhone(rawPhone, subsDelNo);
    const serviceEndDate = normalizeDate(rawServiceEnd) || undefined;
    const rDate = normalizeDate(rawRDate) || undefined;
    const name = rawName.trim() || 'Airtel Subscriber';
    const address = rawAddress.trim() || 'Address On Record';

    leads.push({
      name,
      phone,
      address,
      subs_del_no: subsDelNo || undefined,
      account_no: accountNo || undefined,
      service_end_date: serviceEndDate,
      r_date: rDate,
      check: rawCheck || undefined,
      language: 'hi',
    });
  }

  return leads;
}
