/**
 * Real Estate (My Estate Finder / Priya) Canonical Dispositions.
 * Mirrors the canonical disposition system in backend/src/utils/dispositions.ts (Airtel).
 */

export const REAL_ESTATE_CANONICAL_DISPOSITIONS = [
  'Qualified Lead',
  'Schedule Callback',
  'Advisor Callback Booked',
  'WhatsApp Info Requested',
  'Not Interested',
  'Do Not Call',
  'Wrong Number',
  'Not Connected (No Answer)',
  'Abruptly Disconnected Call',
] as const;

export type RealEstateCanonicalDisposition = typeof REAL_ESTATE_CANONICAL_DISPOSITIONS[number];

/**
 * Terminal dispositions - Lead qualification completed, customer refused, or invalid contact.
 * Lead is closed, no automatic redialing needed.
 */
export const TERMINAL_RE_DISPOSITIONS: RealEstateCanonicalDisposition[] = [
  'Qualified Lead',
  'Not Interested',
  'Do Not Call',
  'Wrong Number',
];

/**
 * Retriable / Actionable dispositions - Follow-up needed or eligible for retry.
 */
export const ACTIONABLE_RE_DISPOSITIONS: RealEstateCanonicalDisposition[] = [
  'Schedule Callback',
  'Advisor Callback Booked',
  'WhatsApp Info Requested',
  'Not Connected (No Answer)',
  'Abruptly Disconnected Call',
];

/**
 * Checks whether a given real estate disposition is terminal
 */
export function isTerminalRealEstateDisposition(disposition?: string | null): boolean {
  if (!disposition) return false;
  const canonical = matchRealEstateDisposition(disposition);
  return TERMINAL_RE_DISPOSITIONS.includes(canonical);
}

/**
 * Maps raw agent outcome text, disposition, or call status to one of the canonical Real Estate dispositions.
 */
export function matchRealEstateDisposition(
  rawInput?: string | null,
  durationSeconds?: number | null,
  callStatus?: string | null,
  isInterested?: boolean | null
): RealEstateCanonicalDisposition {
  const text = (rawInput || '').trim();
  const upper = text.toUpperCase().replace(/[-_]/g, ' ');
  const statusUpper = (callStatus || '').toUpperCase().replace(/[-_]/g, ' ');
  const duration = Number(durationSeconds) || 0;

  // Exact canonical match check
  const exact = REAL_ESTATE_CANONICAL_DISPOSITIONS.find(
    (c) => c.toLowerCase() === text.toLowerCase() || c.toUpperCase() === upper
  );
  if (exact) return exact;

  // 1. Do Not Call (DNC) - Highest priority suppression check
  if (
    upper.includes('DO NOT CALL') ||
    upper.includes('DONT CALL') ||
    upper.includes('CALL MAT KARNA') ||
    upper.includes('MAT KARNA') ||
    upper.includes('NUMBER HATA') ||
    upper.includes('NUMBER DELETE') ||
    upper.includes('DNC') ||
    upper.includes('DND') ||
    upper.includes('STOP CALLING') ||
    upper.includes('REMOVE NUMBER') ||
    upper.includes('SUPPRESS')
  ) {
    return 'Do Not Call';
  }

  // 2. Wrong Number / Wrong Person / Invalid Number
  if (
    upper.includes('WRONG NUMBER') ||
    upper.includes('WRONG PERSON') ||
    upper.includes('NOT OWNER') ||
    upper.includes('INVALID NUMBER') ||
    upper.includes('NOT ME')
  ) {
    return 'Wrong Number';
  }

  // 3. WhatsApp Info Requested
  if (
    upper.includes('WHATSAPP') ||
    upper.includes('WA INFO') ||
    upper.includes('BROCHURE')
  ) {
    return 'WhatsApp Info Requested';
  }

  // 4. Advisor Callback Booked (Handoff / Impatience / Valuation)
  if (
    upper.includes('ADVISOR') ||
    upper.includes('HANDOFF') ||
    upper.includes('HUMAN') ||
    upper.includes('VALUATION') ||
    upper.includes('IMPATIENT')
  ) {
    return 'Advisor Callback Booked';
  }

  // 5. Schedule Callback
  if (
    upper.includes('CALLBACK') ||
    upper.includes('CALL BACK') ||
    upper.includes('CALL LATER') ||
    upper.includes('CALL ME LATER') ||
    upper.includes('CALL AGAIN') ||
    upper.includes('BAAD MEIN') ||
    upper.includes('TOMORROW') ||
    upper.includes('BUSY') ||
    upper.includes('SCHEDULE')
  ) {
    return 'Schedule Callback';
  }

  // 6. Not Interested (Must take precedence over any partial property mentions)
  if (
    isInterested === false ||
    upper.includes('NOT INTERESTED') ||
    upper.includes('DECLINED') ||
    upper.includes('REFUSED') ||
    upper.includes('NAHI BECHNI') ||
    upper.includes('NO INTENT')
  ) {
    return 'Not Interested';
  }

  // 7. Qualified Lead: requires positive interest and complete qualification
  // NEVER classify as Qualified Lead simply because "residential" or "commercial" appeared in text
  if (
    upper.includes('QUALIFIED') ||
    upper.includes('INTAKE COMPLETE') ||
    upper.includes('DETAILS CAPTURED')
  ) {
    return 'Qualified Lead';
  }

  // 8. Technical: Not Connected / No Answer (only when call duration is 0s)
  if (
    duration === 0 && (
      statusUpper === 'NO ANSWER' ||
      statusUpper === 'NO_ANSWER' ||
      statusUpper === 'FAILED' ||
      upper.includes('NOT CONNECTED') ||
      upper.includes('NO ANSWER') ||
      upper.includes('TIMEOUT') ||
      statusUpper.includes('FAIL') ||
      statusUpper.includes('REJECT')
    )
  ) {
    return 'Not Connected (No Answer)';
  }

  // 9. Abrupt Disconnect
  if (
    upper.includes('DISCONNECT') ||
    upper.includes('ABRUPT') ||
    upper.includes('DROPPED') ||
    upper.includes('PARTIAL')
  ) {
    return 'Abruptly Disconnected Call';
  }

  // Safe fallback based on call duration:
  // Calls that connect and disconnect without full qualification are Abruptly Disconnected
  if (duration >= 5) {
    return 'Abruptly Disconnected Call';
  }

  return 'Not Connected (No Answer)';
}

