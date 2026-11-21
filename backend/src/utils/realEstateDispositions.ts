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
  'Voicemail or IVR Detected',
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
  'Voicemail or IVR Detected',
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
  isInterested?: boolean | null,
  agentSummary?: string | null
): RealEstateCanonicalDisposition {
  const text = (rawInput || '').trim();
  const upper = text.toUpperCase().replace(/[-_]/g, ' ');
  const statusUpper = (callStatus || '').toUpperCase().replace(/[-_]/g, ' ');
  const summaryUpper = (agentSummary || '').toUpperCase().replace(/[-_]/g, ' ');
  const duration = Number(durationSeconds) || 0;

  if (upper.includes('PENDING') || (!text && !callStatus)) {
    return 'Pending Outreach' as any;
  }

  // 0. Voicemail / IVR / carrier announcement / hold timeout (no human on the line)
  // Check this BEFORE checking duration or exact matches to prevent IVR calls with duration from becoming Abruptly Disconnected Call
  if (
    upper.includes('VOICEMAIL') ||
    upper.includes('VOICE MAIL') ||
    /\bIVR\b/.test(upper) ||
    upper.includes('ANSWERING MACHINE') ||
    upper.includes('CARRIER ANNOUNCEMENT') ||
    upper.includes('CARRIER MESSAGE') ||
    upper.includes('AUTOMATED MESSAGE') ||
    upper.includes('RECORD YOUR MESSAGE') ||
    upper.includes('AT THE TONE') ||
    upper.includes('AFTER THE BEEP') ||
    upper.includes('AFTER THE TONE') ||
    upper.includes('FINISHED RECORDING') ||
    upper.includes('WAITING FOR HUMAN') ||
    summaryUpper.includes('WAITING FOR HUMAN') ||
    summaryUpper.includes('VOICEMAIL') ||
    /\bIVR\b/.test(summaryUpper) ||
    summaryUpper.includes('CARRIER ANNOUNCEMENT') ||
    summaryUpper.includes('RECORD YOUR MESSAGE') ||
    summaryUpper.includes('AT THE TONE') ||
    summaryUpper.includes('AFTER THE BEEP') ||
    summaryUpper.includes('AFTER THE TONE') ||
    summaryUpper.includes('FINISHED RECORDING') ||
    (upper.includes('HOLD') && (upper.includes('CALLEE') || upper.includes('SUBSCRIBER') || upper.includes('TIMED OUT'))) ||
    (summaryUpper.includes('HOLD') && (summaryUpper.includes('CALLEE') || summaryUpper.includes('SUBSCRIBER') || summaryUpper.includes('TIMED OUT')))
  ) {
    return 'Voicemail or IVR Detected';
  }

  // If call connected and lasted > 0 seconds, it is not "No Answer" even if caller hung up silently
  if (duration > 0 && (upper === 'NOT CONNECTED (NO ANSWER)' || upper.includes('NO ANSWER') || upper.includes('NOT CONNECTED'))) {
    return 'Abruptly Disconnected Call';
  }

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

  // 4. Not Interested (Must take precedence over partial mentions, but after DNC & Wrong Number)
  // If caller confirmed positive interest (isInterested === true), they are never marked Not Interested
  if (
    isInterested !== true && (
      isInterested === false ||
      upper.includes('NOT INTERESTED') ||
      upper.includes('DECLINED') ||
      upper.includes('REFUSED') ||
      upper.includes('NAHI BECHNI') ||
      upper.includes('NO INTENT') ||
      upper.includes('ALREADY SOLD') ||
      upper.includes('ALREADY RENTED') ||
      summaryUpper.includes('NOT INTERESTED') ||
      summaryUpper.includes('REFUSED') ||
      summaryUpper.includes('ALREADY SOLD') ||
      summaryUpper.includes('ALREADY RENTED') ||
      summaryUpper.includes('NO PROPERTY') ||
      summaryUpper.includes("DON'T HAVE")
    )
  ) {
    return 'Not Interested';
  }

  // 5. Advisor Callback Booked (Handoff / Impatience / Valuation / Pricing / Interested Partial Details)
  if (
    upper.includes('ADVISOR') ||
    upper.includes('HANDOFF') ||
    upper.includes('HUMAN') ||
    upper.includes('VALUATION') ||
    upper.includes('IMPATIENT') ||
    upper.includes('PRICING') ||
    summaryUpper.includes('ADVISOR') ||
    summaryUpper.includes('VALUATION') ||
    summaryUpper.includes('PRICING') ||
    upper.includes('PARTIAL') ||
    upper.includes('INTERESTED')
  ) {
    return 'Advisor Callback Booked';
  }

  // 6. Schedule Callback
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

  // 7. Abrupt Disconnect (Early hang-up with no interest or property details captured)
  if (
    upper.includes('DISCONNECT') ||
    upper.includes('ABRUPT') ||
    upper.includes('DROPPED') ||
    upper.includes('HANGUP') ||
    upper.includes('HUNG UP') ||
    upper.includes('CUT')
  ) {
    return 'Abruptly Disconnected Call';
  }

  // 8. Qualified Lead: requires positive interest and complete qualification without early disconnect
  // NEVER classify as Qualified Lead simply because "residential", "commercial", or partial details appeared
  if (
    upper === 'QUALIFIED LEAD' ||
    upper === 'QUALIFIED' ||
    upper.includes('INTAKE COMPLETE') ||
    upper === 'ALL DETAILS CAPTURED'
  ) {
    return 'Qualified Lead';
  }

  // 9. Technical: Not Connected / No Answer (only when call duration is 0s)
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

  // Safe fallback based on call duration:
  // Calls that connect and disconnect without full qualification are Abruptly Disconnected
  if (duration >= 5) {
    return 'Abruptly Disconnected Call';
  }

  return 'Not Connected (No Answer)';
}
