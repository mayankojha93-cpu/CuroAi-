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
  check_status?: string;
  check?: string;
  cust_email?: string;
  customer_identifier?: string;
  alternate_phones?: string[];
  alternate_phone?: string;
  pincode?: string;
  zone?: string;
  town_flag?: string;
  service_city?: string;
  disconnection_reason?: string;
  circle_new?: string;
  circle_new20?: string;
  allocated_to?: string;
  product_name?: string;
}

/**
 * Extracts a 6-digit Indian PIN code from an address string if present.
 */
export function extractPincode(address?: string | null): string {
  if (!address) return '';
  const match = address.match(/\b([1-9][0-9]{5})\b/);
  return match ? match[1] : '';
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
 * Supports target columns:
 * "R. DATE", "SUBS_DEL_NO", "SERVICE_END", "ADDRESS", "CUST_EMAIL",
 * "CONTACT_PHONE" (multiple: CONTACT_PHONE1, CONTACT_PHONE2, etc.), "SUBS_NAME", "CUSTOMER_IDENTIFER"
 */
export function parseCsvToLeads(csvText: string): ParsedTelecomLead[] {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const rawHeaders = rows[0];
  const normalizedHeaders = rawHeaders.map(h => h.trim().toLowerCase().replace(/[\s\._\-]/g, ''));
  const headerMap: Record<string, number> = {};
  const phoneCols: number[] = [];

  normalizedHeaders.forEach((header, index) => {
    if (header.includes('rdate') || header === 'rdate' || header === 'date') {
      headerMap['r_date'] = index;
    } else if (header.includes('subsdel') || header.includes('subscriberdel') || header === 'wifiid' || header.includes('subsno')) {
      headerMap['subs_del_no'] = index;
    } else if (header.includes('customerident') || header.includes('custident') || header.includes('identifier')) {
      headerMap['customer_identifier'] = index;
      if (headerMap['account_no'] === undefined) headerMap['account_no'] = index;
    } else if (header.includes('account') || header.includes('accno') || header.includes('custid')) {
      headerMap['account_no'] = index;
      if (headerMap['customer_identifier'] === undefined) headerMap['customer_identifier'] = index;
    } else if (header.includes('serviceend') || header.includes('enddate') || header === 'serviceend') {
      headerMap['service_end_date'] = index;
    } else if (header.includes('address') || header === 'addr') {
      headerMap['address'] = index;
    } else if (header.includes('servicecity') || header === 'city') {
      headerMap['service_city'] = index;
    } else if (header.includes('disconnection') || header.includes('reason')) {
      headerMap['disconnection_reason'] = index;
    } else if (header.includes('townflag') || header.includes('town')) {
      headerMap['town_flag'] = index;
    } else if (header.includes('circlenew20')) {
      headerMap['circle_new20'] = index;
    } else if (header.includes('circlenew') || header.includes('circle')) {
      headerMap['circle_new'] = index;
    } else if (header.includes('pincode') || header.includes('pin') || header.includes('postal') || header.includes('zip')) {
      headerMap['pincode'] = index;
    } else if (header.includes('zone')) {
      headerMap['zone'] = index;
    } else if (header.includes('allocated') || header.includes('allocate')) {
      headerMap['allocated_to'] = index;
    } else if (header.includes('email') || header.includes('mail')) {
      headerMap['cust_email'] = index;
    } else if (header.includes('subsname') || header.includes('subscribername') || header.includes('customername') || header === 'name' || header === 'subs_name') {
      headerMap['name'] = index;
    } else if (header.includes('check')) {
      headerMap['check'] = index;
    } else if (header.includes('phone') || header.includes('mobile') || header.includes('contact')) {
      phoneCols.push(index);
    }
  });

  // If no columns were explicitly identified as phone, check any unmapped columns containing 'number' or 'tel'
  if (phoneCols.length === 0) {
    normalizedHeaders.forEach((header, index) => {
      if (header.includes('phone') || header.includes('mobile') || header.includes('contact') || header.includes('number') || header.includes('tel')) {
        if (
          index !== headerMap['subs_del_no'] &&
          index !== headerMap['customer_identifier'] &&
          index !== headerMap['account_no'] &&
          index !== headerMap['pincode']
        ) {
          phoneCols.push(index);
        }
      }
    });
  }

  const leads: ParsedTelecomLead[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const subsDelNo = headerMap['subs_del_no'] !== undefined ? row[headerMap['subs_del_no']] : '';
    const accountNo = headerMap['account_no'] !== undefined ? row[headerMap['account_no']] : '';
    const customerIdentifier = headerMap['customer_identifier'] !== undefined ? row[headerMap['customer_identifier']] : '';
    const rawAddress = headerMap['address'] !== undefined ? row[headerMap['address']] : '';
    const rawName = headerMap['name'] !== undefined ? row[headerMap['name']] : '';
    const rawEmail = headerMap['cust_email'] !== undefined ? row[headerMap['cust_email']] : '';
    const rawRDate = headerMap['r_date'] !== undefined ? row[headerMap['r_date']] : '';
    const rawServiceEnd = headerMap['service_end_date'] !== undefined ? row[headerMap['service_end_date']] : '';
    const rawCheck = headerMap['check'] !== undefined ? row[headerMap['check']] : '';
    const rawPincode = headerMap['pincode'] !== undefined ? row[headerMap['pincode']] : '';
    const rawZone = headerMap['zone'] !== undefined ? row[headerMap['zone']] : '';
    const rawTownFlag = headerMap['town_flag'] !== undefined ? row[headerMap['town_flag']] : '';
    const rawServiceCity = headerMap['service_city'] !== undefined ? row[headerMap['service_city']] : '';
    const rawDisconnectionReason = headerMap['disconnection_reason'] !== undefined ? row[headerMap['disconnection_reason']] : '';
    const rawCircleNew = headerMap['circle_new'] !== undefined ? row[headerMap['circle_new']] : '';
    const rawCircleNew20 = headerMap['circle_new20'] !== undefined ? row[headerMap['circle_new20']] : '';
    const rawAllocatedTo = headerMap['allocated_to'] !== undefined ? row[headerMap['allocated_to']] : '';

    // Collect all candidate phones from all phone columns for this row
    const candidatePhones: string[] = [];
    for (const pIdx of phoneCols) {
      if (row[pIdx] && row[pIdx].trim()) {
        candidatePhones.push(row[pIdx].trim());
      }
    }

    if (!subsDelNo && !accountNo && !rawAddress && candidatePhones.length === 0) {
      continue;
    }

    // Validate and normalize all phones
    const validPhones: string[] = [];
    for (const rawP of candidatePhones) {
      const norm = normalizePhone(rawP);
      if (norm && norm !== '+910000000000' && !validPhones.includes(norm)) {
        validPhones.push(norm);
      }
    }

    // Fallback to subsDelNo if no valid phone found in phone columns
    if (validPhones.length === 0 && subsDelNo) {
      const fromSubs = normalizePhone(undefined, subsDelNo);
      if (fromSubs && fromSubs !== '+910000000000') {
        validPhones.push(fromSubs);
      }
    }

    const primaryPhone = validPhones[0] || '';
    const altPhones = validPhones.slice(1);
    const serviceEndDate = normalizeDate(rawServiceEnd) || undefined;
    const rDate = normalizeDate(rawRDate) || undefined;
    const name = rawName.trim() || 'Airtel Subscriber';
    const address = rawAddress.trim() || 'Address On Record';
    const pincode = rawPincode.trim() || extractPincode(address) || undefined;

    leads.push({
      name,
      phone: primaryPhone,
      alternate_phones: altPhones.length > 0 ? altPhones : undefined,
      alternate_phone: altPhones[0] || undefined,
      address,
      cust_email: rawEmail.trim() || undefined,
      customer_identifier: customerIdentifier.trim() || undefined,
      subs_del_no: subsDelNo || undefined,
      account_no: accountNo || customerIdentifier.trim() || undefined,
      service_end_date: serviceEndDate,
      r_date: rDate,
      check_status: rawCheck.trim() || undefined,
      check: rawCheck.trim() || undefined,
      pincode,
      zone: rawZone.trim() || undefined,
      town_flag: rawTownFlag.trim() || undefined,
      service_city: rawServiceCity.trim() || undefined,
      disconnection_reason: rawDisconnectionReason.trim() || undefined,
      circle_new: rawCircleNew.trim() || undefined,
      circle_new20: rawCircleNew20.trim() || undefined,
      allocated_to: rawAllocatedTo.trim() || undefined,
      product_name: 'Airtel IP TV',
      language: 'hi',
    });
  }

  return leads;
}
