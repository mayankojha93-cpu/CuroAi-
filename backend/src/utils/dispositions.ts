export const CANONICAL_DISPOSITIONS = [
  'Confirmed For Pickup',
  'Willing To Pickup',
  'Schedule Callback',
  'Already Returned Device',
  'Refused To Return',
  'Willing To Recharge',
  'Already Recharged',
  'Wrong Number',
  'Language Barrier',
  'Do Not Call',
  'Abruptly Disconnected Call',
  'Voicemail or IVR Detected',
  'Not Connected (No Answer)',
  'Not Connected (Failed)',
] as const;

export type CanonicalDisposition = typeof CANONICAL_DISPOSITIONS[number];

/**
 * Terminal dispositions - Lead goal reached, customer refused, or invalid contact.
 * Customer lead is permanently closed (`is_closed = TRUE`), no further retries.
 */
export const TERMINAL_DISPOSITIONS: CanonicalDisposition[] = [
  'Confirmed For Pickup',
  'Already Returned Device',
  'Refused To Return',
  'Already Recharged',
  'Wrong Number',
  'Do Not Call',
];

/**
 * Non-terminal dispositions - Lead still eligible for redials if attempts < max_attempts.
 */
export const RETRIABLE_DISPOSITIONS: CanonicalDisposition[] = [
  'Willing To Pickup',
  'Schedule Callback',
  'Willing To Recharge',
  'Language Barrier',
  'Abruptly Disconnected Call',
  'Voicemail or IVR Detected',
  'Not Connected (No Answer)',
  'Not Connected (Failed)',
];

/**
 * Checks whether a given disposition is terminal (contact closed)
 */
export function isTerminalDisposition(disposition?: string | null): boolean {
  if (!disposition) return false;
  const canonical = matchCanonicalDisposition(disposition);
  return TERMINAL_DISPOSITIONS.includes(canonical as CanonicalDisposition);
}

/**
 * Maps any raw outcome / disposition text or call state to one of the 14 Canonical Dispositions.
 */
export function matchCanonicalDisposition(
  rawInput?: string | null,
  durationSeconds?: number | null,
  callStatus?: string | null
): CanonicalDisposition {
  const text = (rawInput || '').trim();
  const upper = text.toUpperCase().replace(/[-_]/g, ' ');
  const statusUpper = (callStatus || '').toUpperCase().replace(/[-_]/g, ' ');
  const duration = Number(durationSeconds) || 0;

  // Direct exact match
  const exactMatch = CANONICAL_DISPOSITIONS.find(
    (c) => c.toLowerCase() === text.toLowerCase() || c.toUpperCase() === upper
  );
  if (exactMatch) return exactMatch;

  // 8. Wrong Number (Check early so 'IDENTITY NOT CONFIRMED' does not trigger 'CONFIRMED')
  if (
    upper.includes('WRONG NUMBER') ||
    upper.includes('WRONG PERSON') ||
    upper.includes('NOT CONFIRMED') ||
    upper.includes('IDENTITY NOT CONFIRMED') ||
    upper.includes('NOT SUBSCRIBER') ||
    upper.includes('INVALID NUMBER') ||
    upper.includes('NOT ME') ||
    upper.includes('DOES NOT BELONG')
  ) {
    return 'Wrong Number';
  }

  // 10. Do Not Call
  if (
    upper.includes('DO NOT CALL') ||
    upper.includes('DND') ||
    upper.includes('STOP CALLING') ||
    upper.includes('UNSUBSCRIBE') ||
    upper.includes('DONOTCALL') ||
    upper.includes('NEVER CALL')
  ) {
    return 'Do Not Call';
  }

  // 9. Language Barrier
  if (
    upper.includes('LANGUAGE BARRIER') ||
    upper.includes('LANGUAGE') ||
    upper.includes('BARRIER') ||
    upper.includes('NOT UNDERSTAND') ||
    upper.includes('SPEAK TAMIL') ||
    upper.includes('SPEAK TELUGU') ||
    upper.includes('SPEAK BENGALI') ||
    upper.includes('SPEAK MARATHI') ||
    upper.includes('SPEAK KANNADA') ||
    upper.includes('SPEAK MALAYALAM')
  ) {
    return 'Language Barrier';
  }

  // 12. Voicemail or IVR Detected
  if (
    upper.includes('VOICEMAIL') ||
    upper.includes('IVR') ||
    upper.includes('ANSWERING MACHINE') ||
    upper.includes('MACHINE DETECTED') ||
    upper.includes('CARRIER MESSAGE') ||
    upper.includes('AUTOMATED MESSAGE')
  ) {
    return 'Voicemail or IVR Detected';
  }

  // 4. Already Returned Device
  if (
    upper.includes('ALREADY RETURNED') ||
    upper.includes('ALREADY PICKED UP') ||
    upper.includes('DEVICE RETURNED') ||
    upper.includes('RETURNED DEVICE') ||
    upper.includes('HANDED OVER') ||
    upper.includes('DEPOSITED') ||
    upper.includes('ALREADY SUBMITTED')
  ) {
    return 'Already Returned Device';
  }

  // 6. Willing To Recharge
  if (
    upper.includes('WILLING TO RECHARGE') ||
    upper.includes('WILL RECHARGE') ||
    upper.includes('PROMISED RECHARGE') ||
    upper.includes('RECHARGE PROMISED') ||
    upper.includes('WILL PAY') ||
    upper.includes('PROMISE TO PAY')
  ) {
    return 'Willing To Recharge';
  }

  // 7. Already Recharged
  if (
    upper.includes('ALREADY RECHARGED') ||
    upper.includes('RECHARGED DEVICE') ||
    upper.includes('RECHARGED') ||
    upper.includes('ALREADY PAID') ||
    upper.includes('ACCOUNT ACTIVE') ||
    upper.includes('PAYMENT DONE') ||
    upper.includes('ALREADY USING') ||
    upper.includes('STILL USING')
  ) {
    return 'Already Recharged';
  }

  // 1. Confirmed For Pickup
  if (
    upper.includes('CONFIRMED FOR PICKUP') ||
    upper.includes('PICKUP CONFIRMED') ||
    upper.includes('CONFIRMED PICKUP') ||
    upper.includes('GOAL COMPLETED') ||
    upper.includes('PICKUP SCHEDULED') ||
    upper.includes('SCHEDULED PICKUP') ||
    upper.includes('CONFIRMED DATE') ||
    upper.includes('PICKUP ACCEPTED') ||
    (upper.includes('CONFIRMED') && !upper.includes('NOT CONFIRMED'))
  ) {
    return 'Confirmed For Pickup';
  }

  // 2. Willing To Pickup
  if (
    upper.includes('WILLING TO PICKUP') ||
    upper.includes('WILLING PICKUP') ||
    upper.includes('TENTATIVE PICKUP') ||
    upper.includes('WILLING TO RETURN') ||
    upper.includes('AGREED TO RETURN') ||
    upper.includes('WILL RETURN') ||
    upper.includes('RECORD WILLING NO DATE') ||
    upper.includes('WILLING NO DATE')
  ) {
    return 'Willing To Pickup';
  }

  // 5. Refused To Return
  if (
    upper.includes('REFUSED TO RETURN') ||
    upper.includes('PICKUP DECLINED') ||
    upper.includes('REFUSED') ||
    upper.includes('DECLINED') ||
    upper.includes('NOT GIVING') ||
    upper.includes('DENIED') ||
    upper.includes('DECLINED PICKUP') ||
    upper.includes('DAMAGED DEVICE') ||
    upper.includes('LOST DEVICE') ||
    upper.includes('REFUND OR OWNERSHIP')
  ) {
    return 'Refused To Return';
  }

  // 3. Schedule Callback
  if (
    upper.includes('SCHEDULE CALLBACK') ||
    upper.includes('CALLBACK REQUESTED') ||
    upper.includes('CALL LATER') ||
    upper.includes('CALLBACK') ||
    upper.includes('BUSY CALL LATER') ||
    upper.includes('SCHEDULED CALLBACK') ||
    upper.includes('CALL ME BACK') ||
    upper.includes('CALL AFTER') ||
    upper.includes('SHIFTED') ||
    upper.includes('NEEDS AIRTEL SUPPORT')
  ) {
    return 'Schedule Callback';
  }

  // 13. Not Connected (No Answer)
  if (
    upper.includes('NO ANSWER') ||
    upper.includes('NO_ANSWER') ||
    upper.includes('NOT CONNECTED NO ANSWER') ||
    upper.includes('NOT CONNECTED (NO ANSWER)') ||
    upper.includes('NO RESPONSE') ||
    upper.includes('TIMEOUT') ||
    upper.includes('RINGING TIMEOUT') ||
    upper.includes('UNANSWERED') ||
    statusUpper === 'NO ANSWER' ||
    statusUpper === 'NO_ANSWER'
  ) {
    return 'Not Connected (No Answer)';
  }

  // 11. Abruptly Disconnected Call
  if (
    upper.includes('ABRUPTLY DISCONNECTED') ||
    upper.includes('DISCONNECTED') ||
    upper.includes('CALL DROPPED') ||
    upper.includes('DROPPED') ||
    upper.includes('HANGUP') ||
    upper.includes('HUNG UP') ||
    upper.includes('CALL CUT') ||
    (duration >= 5 && (statusUpper === 'COMPLETED' || upper.includes('DISCONNECT')))
  ) {
    return 'Abruptly Disconnected Call';
  }

  // 14. Not Connected (Failed)
  if (
    upper.includes('FAILED') ||
    upper.includes('NOT CONNECTED FAILED') ||
    upper.includes('NOT CONNECTED (FAILED)') ||
    upper.includes('BUSY') ||
    upper.includes('UNREACHABLE') ||
    upper.includes('SWITCHED OFF') ||
    upper.includes('OUT OF SERVICE') ||
    upper.includes('NETWORK FAILURE') ||
    statusUpper === 'FAILED' ||
    statusUpper === 'BUSY'
  ) {
    return 'Not Connected (Failed)';
  }

  // Duration/Status based fallbacks
  if (duration >= 5) {
    return 'Abruptly Disconnected Call';
  }
  if (statusUpper.includes('ANSWER') || duration === 0) {
    return 'Not Connected (No Answer)';
  }

  return 'Not Connected (Failed)';
}
