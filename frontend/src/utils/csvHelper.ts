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
    } else if (header.includes('subsdel') || header.includes('subscriber') || header.includes('wifiid') || header.includes('subsno')) {
      headerMap['subs_del_no'] = index;
    } else if (header.includes('customerident') || header.includes('custident') || header.includes('identifier')) {
      headerMap['customer_identifier'] = index;
      if (headerMap['account_no'] === undefined) headerMap['account_no'] = index;
    } else if (header.includes('account') || header.includes('accno') || header.includes('custid')) {
      headerMap['account_no'] = index;
      if (headerMap['customer_identifier'] === undefined) headerMap['customer_identifier'] = index;
    } else if (header.includes('serviceend') || header.includes('enddate') || header === 'serviceend') {
      headerMap['service_end_date'] = index;
    } else if (header.includes('address') || header.includes('addr')) {
      headerMap['address'] = index;
    } else if (header.includes('email') || header.includes('mail')) {
      headerMap['cust_email'] = index;
    } else if (header.includes('subsname') || header.includes('subscribername') || header.includes('customername') || header === 'name' || header === 'subs_name') {
      headerMap['name'] = index;
    } else if (header.includes('check')) {
      headerMap['check'] = index;
    }
  });

  const phoneCols: number[] = [];
  normalizedHeaders.forEach((header, index) => {
    if (header.includes('phone') || header.includes('mobile') || header.includes('contact')) {
      phoneCols.push(index);
    }
  });

  const leads: Partial<CustomerCreateInput>[] = [];
  const errList: string[] = [];

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

    const candidatePhones: string[] = [];
    for (const pIdx of phoneCols) {
      if (row[pIdx] && row[pIdx].trim()) {
        candidatePhones.push(row[pIdx].trim());
      }
    }

    if (!subsDelNo && !accountNo && !rawAddress && candidatePhones.length === 0) {
      continue; // Skip entirely blank rows
    }

    const validPhones: string[] = [];
    for (const rawP of candidatePhones) {
      const norm = normalizePhone(rawP);
      if (norm && !validPhones.includes(norm)) {
        validPhones.push(norm);
      }
    }

    if (validPhones.length === 0 && subsDelNo) {
      const fromSubs = normalizePhone(undefined, subsDelNo);
      if (fromSubs) validPhones.push(fromSubs);
    }

    const phone = validPhones[0] || '';
    const altPhones = validPhones.slice(1);
    const serviceEndDate = normalizeDate(rawServiceEnd);
    const rDate = normalizeDate(rawRDate);
    const name = rawName.trim() || 'Airtel Subscriber';
    const address = rawAddress.trim() || 'Address On Record';

    if (!phone) {
      errList.push(`Row ${i + 1}: Could not determine a phone number from CONTACT_PHONE or SUBS_DEL_NO (${subsDelNo || 'empty'}).`);
      continue;
    }

    leads.push({
      name,
      phone,
      alternate_phones: altPhones.length > 0 ? altPhones : undefined,
      alternate_phone: altPhones[0] || undefined,
      address,
      cust_email: rawEmail.trim() || undefined,
      customer_identifier: customerIdentifier.trim() || undefined,
      subs_del_no: subsDelNo || undefined,
      account_no: accountNo || customerIdentifier.trim() || undefined,
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
 * Extracts a 6-digit Indian PIN code from an address string if present.
 */
export function extractPincode(address?: string | null): string {
  if (!address) return '';
  const match = address.match(/\b([1-9][0-9]{5})\b/);
  return match ? match[1] : '';
}

export interface ParsedAudienceContact {
  phone: string;
  name?: string;
  address?: string;
  cust_email?: string;
  customer_identifier?: string;
  account_no?: string;
  subs_del_no?: string;
  service_end_date?: string;
  r_date?: string;
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
  check_status?: string;
  check?: string;
  product_name?: string;
}

export interface AudienceParseResult {
  validContacts: ParsedAudienceContact[];
  flaggedDuplicates: { raw: string; type: 'duplicate'; reason: string }[];
  flaggedShortNumbers: { raw: string; type: 'short_number'; reason: string }[];
  totalRows: number;
}

/**
 * Parses audience CSV file supporting all 19 columns:
 * R. Date, Check, SUBS_DEL_NO, ACCOUNT_NO, SERVICE_END, Address, SERVICE_CITY,
 * CONTACT_PHONE1, CONTACT_PHONE2, CUST_EMAIL, DISCONNECTION_REASON, TOWN_FLAG,
 * CUSTOMER_IDENTIFER, SUBS_NAME, CIRCLE_NEW, CIRCLE_NEW20, Pin code, Zone, Allocated to
 */
export function parseAudienceCsv(csvText: string): AudienceParseResult {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return { validContacts: [], flaggedDuplicates: [], flaggedShortNumbers: [], totalRows: 0 };
  }

  const rawHeaders = rows[0];
  const normalizedHeaders = rawHeaders.map((h) =>
    h.trim().toLowerCase().replace(/[\s\._\-]/g, '')
  );

  let rDateCol = -1;
  let checkCol = -1;
  let subsDelNoCol = -1;
  let accountNoCol = -1;
  let serviceEndCol = -1;
  let addressCol = -1;
  let serviceCityCol = -1;
  let emailCol = -1;
  let discReasonCol = -1;
  let townFlagCol = -1;
  let identifierCol = -1;
  let nameCol = -1;
  let circleNewCol = -1;
  let circleNew20Col = -1;
  let pincodeCol = -1;
  let zoneCol = -1;
  let allocatedToCol = -1;
  const phoneCols: number[] = [];

  normalizedHeaders.forEach((header, index) => {
    if (header === 'rdate' || header.includes('rdate') || header === 'date') {
      rDateCol = index;
    } else if (header.includes('subsdel') || header.includes('subscriberdel') || header === 'wifiid' || header.includes('subsno')) {
      subsDelNoCol = index;
    } else if (header.includes('serviceend') || header.includes('enddate')) {
      serviceEndCol = index;
    } else if (header.includes('address') || header === 'addr') {
      addressCol = index;
    } else if (header.includes('servicecity') || header === 'city') {
      serviceCityCol = index;
    } else if (header.includes('disconnection') || header.includes('reason')) {
      discReasonCol = index;
    } else if (header.includes('townflag') || header.includes('town')) {
      townFlagCol = index;
    } else if (header.includes('circlenew20')) {
      circleNew20Col = index;
    } else if (header.includes('circlenew') || header.includes('circle')) {
      circleNewCol = index;
    } else if (header.includes('pincode') || header.includes('pin') || header.includes('postal') || header.includes('zip')) {
      pincodeCol = index;
    } else if (header.includes('zone')) {
      zoneCol = index;
    } else if (header.includes('allocated') || header.includes('allocate')) {
      allocatedToCol = index;
    } else if (header.includes('email') || header.includes('mail')) {
      emailCol = index;
    } else if (header.includes('subsname') || header.includes('subscribername') || header.includes('customername') || header === 'name' || header === 'subs_name') {
      nameCol = index;
    } else if (header.includes('customerident') || header.includes('custident') || header.includes('identifier')) {
      identifierCol = index;
      if (accountNoCol === -1) accountNoCol = index;
    } else if (header.includes('account') || header.includes('accno') || header.includes('custid')) {
      accountNoCol = index;
      if (identifierCol === -1) identifierCol = index;
    } else if (header.includes('check')) {
      checkCol = index;
    } else if (header.includes('phone') || header.includes('mobile') || header.includes('contact')) {
      phoneCols.push(index);
    }
  });

  if (phoneCols.length === 0) {
    normalizedHeaders.forEach((header, index) => {
      if (header.includes('phone') || header.includes('mobile') || header.includes('contact') || header.includes('number') || header.includes('tel')) {
        if (index !== subsDelNoCol && index !== identifierCol && index !== accountNoCol && index !== pincodeCol) {
          phoneCols.push(index);
        }
      }
    });
  }

  const valid: ParsedAudienceContact[] = [];
  const duplicates: { raw: string; type: 'duplicate'; reason: string }[] = [];
  const shortNumbers: { raw: string; type: 'short_number'; reason: string }[] = [];
  const seenPhones = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 0 || row.every((c) => !c.trim())) continue;

    const candidatePhones: string[] = [];
    for (const pIdx of phoneCols) {
      if (row[pIdx] && row[pIdx].trim()) {
        candidatePhones.push(row[pIdx].trim());
      }
    }

    const rawSubsDelNo = subsDelNoCol >= 0 ? row[subsDelNoCol]?.trim() : '';
    if (candidatePhones.length === 0 && rawSubsDelNo) {
      candidatePhones.push(rawSubsDelNo);
    }

    const rowValidPhones: string[] = [];
    for (const rawPhone of candidatePhones) {
      let clean = rawPhone.replace(/^["']|["']$/g, '').trim();
      clean = clean.replace(/_(wifi|broadband|dsl|ftth|airtel)/gi, '').trim();
      const digits = clean.replace(/\D/g, '');

      if (!digits) continue;

      if (digits.length < 10) {
        shortNumbers.push({
          raw: rawPhone,
          type: 'short_number',
          reason: `Row ${i + 1}: Less than 10 digits (${digits.length} digits found)`,
        });
        continue;
      }

      let normalized = clean.replace(/[^\d+]/g, '');
      if (!normalized.startsWith('+') && digits.length === 10) {
        normalized = '+91' + digits;
      } else if (!normalized.startsWith('+') && digits.length === 11 && digits.startsWith('0')) {
        normalized = '+91' + digits.slice(1);
      } else if (!normalized.startsWith('+')) {
        normalized = '+' + digits;
      }

      if (!rowValidPhones.includes(normalized)) {
        rowValidPhones.push(normalized);
      }
    }

    if (rowValidPhones.length === 0) {
      continue;
    }

    const primaryPhone = rowValidPhones[0];
    const alternatePhones = rowValidPhones.slice(1);

    if (seenPhones.has(primaryPhone)) {
      duplicates.push({
        raw: primaryPhone,
        type: 'duplicate',
        reason: `Row ${i + 1}: Duplicate phone number ${primaryPhone}`,
      });
      continue;
    }

    seenPhones.add(primaryPhone);

    const rawRDate = rDateCol >= 0 ? row[rDateCol] : '';
    const rawCheck = checkCol >= 0 ? row[checkCol] : '';
    const rawAccountNo = accountNoCol >= 0 ? row[accountNoCol] : '';
    const rawServiceEnd = serviceEndCol >= 0 ? row[serviceEndCol] : '';
    const rawAddress = addressCol >= 0 ? row[addressCol] : '';
    const rawServiceCity = serviceCityCol >= 0 ? row[serviceCityCol] : '';
    const rawEmail = emailCol >= 0 ? row[emailCol] : '';
    const rawDiscReason = discReasonCol >= 0 ? row[discReasonCol] : '';
    const rawTownFlag = townFlagCol >= 0 ? row[townFlagCol] : '';
    const rawIdentifier = identifierCol >= 0 ? row[identifierCol] : '';
    const rawName = nameCol >= 0 ? row[nameCol] : '';
    const rawCircleNew = circleNewCol >= 0 ? row[circleNewCol] : '';
    const rawCircleNew20 = circleNew20Col >= 0 ? row[circleNew20Col] : '';
    const rawPincode = pincodeCol >= 0 ? row[pincodeCol] : '';
    const rawZone = zoneCol >= 0 ? row[zoneCol] : '';
    const rawAllocatedTo = allocatedToCol >= 0 ? row[allocatedToCol] : '';

    const cleanAddress = rawAddress ? rawAddress.trim().replace(/^["']|["']$/g, '') : 'Address On Record';
    const pincode = rawPincode ? rawPincode.trim().replace(/^["']|["']$/g, '') : (extractPincode(cleanAddress) || undefined);

    valid.push({
      phone: primaryPhone,
      alternate_phones: alternatePhones.length > 0 ? alternatePhones : undefined,
      alternate_phone: alternatePhones[0] || undefined,
      name: rawName ? rawName.trim().replace(/^["']|["']$/g, '') : `Subscriber ${primaryPhone.slice(-4)}`,
      address: cleanAddress,
      cust_email: rawEmail ? rawEmail.trim().replace(/^["']|["']$/g, '') : undefined,
      customer_identifier: rawIdentifier ? rawIdentifier.trim().replace(/^["']|["']$/g, '') : undefined,
      account_no: rawAccountNo ? rawAccountNo.trim().replace(/^["']|["']$/g, '') : (rawIdentifier ? rawIdentifier.trim().replace(/^["']|["']$/g, '') : undefined),
      subs_del_no: rawSubsDelNo || undefined,
      service_end_date: normalizeDate(rawServiceEnd) || undefined,
      r_date: normalizeDate(rawRDate) || undefined,
      check_status: rawCheck ? rawCheck.trim() : undefined,
      check: rawCheck ? rawCheck.trim() : undefined,
      pincode,
      zone: rawZone ? rawZone.trim().replace(/^["']|["']$/g, '') : undefined,
      town_flag: rawTownFlag ? rawTownFlag.trim().replace(/^["']|["']$/g, '') : undefined,
      service_city: rawServiceCity ? rawServiceCity.trim().replace(/^["']|["']$/g, '') : undefined,
      disconnection_reason: rawDiscReason ? rawDiscReason.trim().replace(/^["']|["']$/g, '') : undefined,
      circle_new: rawCircleNew ? rawCircleNew.trim().replace(/^["']|["']$/g, '') : undefined,
      circle_new20: rawCircleNew20 ? rawCircleNew20.trim().replace(/^["']|["']$/g, '') : undefined,
      allocated_to: rawAllocatedTo ? rawAllocatedTo.trim().replace(/^["']|["']$/g, '') : undefined,
      product_name: 'Airtel IP TV',
    });
  }

  return {
    validContacts: valid,
    flaggedDuplicates: duplicates,
    flaggedShortNumbers: shortNumbers,
    totalRows: rows.length - 1,
  };
}

/**
 * Generates sample CSV template matching standard columns:
 * R. Date,Check,SUBS_DEL_NO,ACCOUNT_NO,SERVICE_END,Address,SERVICE_CITY,CONTACT_PHONE1,CONTACT_PHONE2,CUST_EMAIL,DISCONNECTION_REASON,TOWN_FLAG,CUSTOMER_IDENTIFER,SUBS_NAME,CIRCLE_NEW,CIRCLE_NEW20,Pin code,Zone,Allocated to
 */
export function getSampleCsvContent(): string {
  return [
    'R. Date,Check,SUBS_DEL_NO,ACCOUNT_NO,SERVICE_END,Address,SERVICE_CITY,CONTACT_PHONE1,CONTACT_PHONE2,CUST_EMAIL,DISCONNECTION_REASON,TOWN_FLAG,CUSTOMER_IDENTIFER,SUBS_NAME,CIRCLE_NEW,CIRCLE_NEW20,Pin code,Zone,Allocated to',
    '29 Aug 26,-,01121344121_wifi,20022941256,27 Aug 26,"Delhi, 110011, burari, sant nagar",,8899855225,9999954242,xyz@gmail.com,,NON LCO,POSTPAID,Raja Nayak,DEL,,110011,North,LOGISTIEX',
    '29 Aug 26,-,01121344122_wifi,20022941257,28 Aug 26,"Flat 204, Pocket 2, Mayur Vihar Phase 1, New Delhi - 110091",,9811223344,,priya@example.com,,NON LCO,POSTPAID,Priya Patel,DEL,,110091,North,LOGISTIEX',
    '29 Aug 26,-,09811122233_wifi,20022941258,25 Aug 26,"C-12, Green Park Extension, New Delhi - 110016",,9822334455,9833445566,amit@example.com,,LCO,POSTPAID,Amit Verma,DEL,,110016,North,LOGISTIEX',
    '30 Aug 26,-,01145678901_wifi,20022941259,29 Aug 26,"Shop 4, Main Market, Lajpat Nagar 2, New Delhi - 110024",,9833445566,,sneha@example.com,,NON LCO,POSTPAID,Sneha Gupta,DEL,,110024,North,LOGISTIEX',
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
 * Generates sample CSV template for Campaign Target Audience upload:
 * R. Date,Check,SUBS_DEL_NO,ACCOUNT_NO,SERVICE_END,Address,SERVICE_CITY,CONTACT_PHONE1,CONTACT_PHONE2,CUST_EMAIL,DISCONNECTION_REASON,TOWN_FLAG,CUSTOMER_IDENTIFER,SUBS_NAME,CIRCLE_NEW,CIRCLE_NEW20,Pin code,Zone,Allocated to
 */
export function getCampaignAudienceSampleCsvContent(): string {
  return [
    'R. Date,Check,SUBS_DEL_NO,ACCOUNT_NO,SERVICE_END,Address,SERVICE_CITY,CONTACT_PHONE1,CONTACT_PHONE2,CUST_EMAIL,DISCONNECTION_REASON,TOWN_FLAG,CUSTOMER_IDENTIFER,SUBS_NAME,CIRCLE_NEW,CIRCLE_NEW20,Pin code,Zone,Allocated to',
    '29 Aug 26,-,01121344121_wifi,20022941256,27 Aug 26,"Delhi, 110011, burari, sant nagar",,8899855225,9999954242,xyz@gmail.com,,NON LCO,POSTPAID,Raja Nayak,DEL,,110011,North,LOGISTIEX',
    '29 Aug 26,-,01121344122_wifi,20022941257,28 Aug 26,"Flat 204, Pocket 2, Mayur Vihar Phase 1, New Delhi - 110091",,9811223344,,priya@example.com,,NON LCO,POSTPAID,Priya Patel,DEL,,110091,North,LOGISTIEX',
    '29 Aug 26,-,09811122233_wifi,20022941258,25 Aug 26,"C-12, Green Park Extension, New Delhi - 110016",,9822334455,9833445566,amit@example.com,,LCO,POSTPAID,Amit Verma,DEL,,110016,North,LOGISTIEX',
    '30 Aug 26,-,01145678901_wifi,20022941259,29 Aug 26,"Shop 4, Main Market, Lajpat Nagar 2, New Delhi - 110024",,9833445566,,sneha@example.com,,NON LCO,POSTPAID,Sneha Gupta,DEL,,110024,North,LOGISTIEX',
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

/**
 * Generates the audited 28-column CSV report with summary headers:
 * Airtel IP TV Final Audited Calling Report
 * <count> unique contacts · <count> total attempts · <count> connected calls
 */
export function generateCampaignAuditedReportCsv(reportData: any[]): string {
  const uniqueContacts = reportData.length;
  const totalAttempts = reportData.reduce((sum, r) => sum + (Number(r.attempts_count) || 0), 0);
  const connectedCalls = reportData.reduce((sum, r) => sum + (Number(r.connected_attempts_count) || 0), 0);

  // 28 columns matching spec exactly
  const headers = [
    'S.No.',
    'Lead Id',
    'SUBS DEL NO',
    'Mobile',
    'Customer Name',
    'Product Name',
    'Address',
    'Pincode',
    'Service End',
    'Account No',
    'Zone',
    'Town Flag',
    'Status',
    'Attempts Count',
    'Connected Attempts Count',
    'First Call Time',
    'Last Call Time',
    'Attempt 1 Disposition',
    'Attempt 2 Disposition',
    'Attempt 3 Disposition',
    'Attempt 4 Disposition',
    'Attempt 5 Disposition',
    'Attempt 6 Disposition',
    'Attempt 7 Disposition',
    'Attempt 8 Disposition',
    'Final Disposition',
    'Conclusion Date',
    'Recording',
  ];

  const escapeCsv = (val: any): string => {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const trailingCommas = ','.repeat(headers.length - 1);

  const lines: string[] = [
    `Airtel IP TV Final Audited Calling Report${trailingCommas}`,
    `${uniqueContacts} unique contacts · ${totalAttempts} total attempts · ${connectedCalls} connected calls${trailingCommas}`,
    trailingCommas,
    headers.join(','),
  ];

  for (const row of reportData) {
    lines.push([
      escapeCsv(row.sno),
      escapeCsv(row.lead_id),
      escapeCsv(row.subs_del_no || '-'),
      escapeCsv(row.mobile),
      escapeCsv(row.customer_name),
      escapeCsv(row.product_name || 'Airtel IP TV'),
      escapeCsv(row.address),
      escapeCsv(row.pincode),
      escapeCsv(row.service_end),
      escapeCsv(row.account_no),
      escapeCsv(row.zone),
      escapeCsv(row.town_flag),
      escapeCsv(row.status),
      escapeCsv(row.attempts_count),
      escapeCsv(row.connected_attempts_count),
      escapeCsv(row.first_call_time),
      escapeCsv(row.last_call_time),
      escapeCsv(row.attempt_1_disposition),
      escapeCsv(row.attempt_2_disposition),
      escapeCsv(row.attempt_3_disposition),
      escapeCsv(row.attempt_4_disposition),
      escapeCsv(row.attempt_5_disposition),
      escapeCsv(row.attempt_6_disposition),
      escapeCsv(row.attempt_7_disposition),
      escapeCsv(row.attempt_8_disposition),
      escapeCsv(row.final_disposition),
      escapeCsv(row.conclusion_date),
      escapeCsv(row.recording),
    ].join(','));
  }

  return lines.join('\n');
}


