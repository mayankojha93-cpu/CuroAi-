import type { CustomerCreateInput } from '../types';

/**
 * Normalizes dates from various formats ("29 Aug 26", "29-Aug-2026", "29/08/2026") into "YYYY-MM-DD"
 */
export function normalizeDate(raw?: string | null): string {
  if (!raw || !raw.trim()) return '';
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

  return str;
}

/**
 * Derives a dialable E.164 phone number.
 * If phone is not provided, extracts numeric digits from subs_del_no (e.g. "01121344121_wifi" -> "+911121344121")
 */
export function normalizePhone(rawPhone?: string | null, subsDelNo?: string | null): string {
  let candidate = (rawPhone || '').trim();

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

  // Standard 10 digit mobile number
  if (digits.length === 10) {
    return `+91${digits}`;
  }

  if (digits.length >= 8) {
    return `+91${digits}`;
  }

  return candidate || '';
}

/**
 * Parses raw CSV/TSV text into an array of string rows with RFC 4180 quote support.
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
      } else if ((char === ',' || char === '\t') && !insideQuotes) {
        row.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    row.push(currentCell.trim());

    if (row.length > 0 && row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

export interface CsvParseResult {
  leads: Partial<CustomerCreateInput>[];
  headers: string[];
  rawRowCount: number;
  validCount: number;
  errors: string[];
}

/**
 * Parses CSV text matching Airtel Telecom columns:
 * "R. Date", "Check", "SUBS_DEL_NO", "ACCOUNT_NO", "SERVICE_END", "Address"
 */
export function parseTelecomCsv(csvText: string): CsvParseResult {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return {
      leads: [],
      headers: rows[0] || [],
      rawRowCount: 0,
      validCount: 0,
      errors: ['File is empty or does not have at least one data row following the header.'],
    };
  }

  const rawHeaders = rows[0];
  const normalizedHeaders = rawHeaders.map((h) => h.trim().toLowerCase().replace(/[\s\._\-]/g, ''));
  const headerMap: Record<string, number> = {};

  normalizedHeaders.forEach((header, index) => {
    if (header.includes('rdate') || header === 'date' || header.includes('r.date')) {
      headerMap['r_date'] = index;
    } else if (header.includes('subsdel') || header.includes('subscriber') || header.includes('wifiid')) {
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

  const leads: Partial<CustomerCreateInput>[] = [];
  const errList: string[] = [];

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
      continue; // Skip entirely blank rows
    }

    const phone = normalizePhone(rawPhone, subsDelNo);
    const serviceEndDate = normalizeDate(rawServiceEnd);
    const rDate = normalizeDate(rawRDate);
    const name = rawName.trim() || 'Airtel Subscriber';
    const address = rawAddress.trim() || 'Address On Record';

    if (!phone) {
      errList.push(`Row ${i + 1}: Could not determine a phone number from SUBS_DEL_NO (${subsDelNo || 'empty'}) or Phone.`);
      continue;
    }

    leads.push({
      name,
      phone,
      address,
      subs_del_no: subsDelNo || undefined,
      account_no: accountNo || undefined,
      service_end_date: serviceEndDate || undefined,
      r_date: rDate || undefined,
      check: rawCheck || undefined,
      language: 'hi',
    });
  }

  return {
    leads,
    headers: rawHeaders,
    rawRowCount: rows.length - 1,
    validCount: leads.length,
    errors: errList,
  };
}

/**
 * Generates sample CSV template matching user's spreadsheet screenshot
 */
export function getSampleCsvContent(): string {
  return [
    'R. Date,Check,SUBS_DEL_NO,ACCOUNT_NO,SERVICE_END,Address',
    '29 Aug 26,.,01121344121_wifi,20022941256,27 Aug 26,"Delhi, 110011, burari, sant nagar"',
    '29 Aug 26,.,01121344122_wifi,20022941257,28 Aug 26,"Flat 204, Pocket 2, Mayur Vihar Phase 1, New Delhi - 110091"',
    '29 Aug 26,.,09811122233_wifi,20022941258,25 Aug 26,"C-12, Green Park Extension, New Delhi - 110016"',
    '30 Aug 26,.,01145678901_wifi,20022941259,29 Aug 26,"Shop 4, Main Market, Lajpat Nagar 2, New Delhi - 110024"',
  ].join('\n');
}

/**
 * Triggers a browser file download for sample CSV
 */
export function downloadSampleCsv(): void {
  const content = getSampleCsvContent();
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', 'airtel_campaign_leads_sample.csv');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generates sample CSV template for Campaign Target Audience upload
 */
export function getCampaignAudienceSampleCsvContent(): string {
  return [
    'phone_number,name,email',
    '+919876543210,Rahul Sharma,rahul.sharma@example.com',
    '+919811223344,Priya Patel,priya.patel@example.com',
    '+919822334455,Amit Verma,amit.verma@example.com',
    '+919833445566,Sneha Gupta,sneha.gupta@example.com',
  ].join('\n');
}

/**
 * Triggers a browser file download for campaign audience sample CSV format
 */
export function downloadCampaignAudienceSampleCsv(): void {
  const content = getCampaignAudienceSampleCsvContent();
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', 'campaign_audience_format.csv');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

