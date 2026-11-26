export type LogisticsCallStatus = 'connected' | 'no_answer' | 'busy_callback' | 'wrong_person';
export type LogisticsUnloadedStatus = 'yes' | 'no' | 'on_the_way' | 'unknown';
export type LogisticsDelayReason =
  | 'queue'
  | 'party_closed'
  | 'weighbridge'
  | 'documents'
  | 'shortage_damage'
  | 'union_charges'
  | 'breakdown'
  | 'other'
  | 'none';
export type LogisticsPriority = 'normal' | 'high' | 'urgent';

export function deriveTripStatusFromOutcome(outcome: {
  call_status?: string;
  unloaded?: string;
  priority?: string;
  escalate_to_human?: string;
}): string {
  if (outcome.priority === 'urgent' || outcome.priority === 'high' || outcome.escalate_to_human === 'yes') {
    return 'ESCALATED';
  }
  if (outcome.call_status === 'no_answer') {
    return 'NO_RESPONSE';
  }
  if (outcome.call_status === 'busy_callback') {
    return 'CALLBACK_SCHEDULED';
  }
  if (outcome.call_status === 'wrong_person') {
    return 'ESCALATED';
  }
  if (outcome.unloaded === 'yes') {
    return 'UNLOADED';
  }
  if (outcome.unloaded === 'no') {
    return 'WAITING_UNLOAD';
  }
  if (outcome.unloaded === 'on_the_way') {
    return 'IN_TRANSIT';
  }
  return 'PENDING';
}

export function deriveCallDisposition(outcome: {
  call_status?: string;
  unloaded?: string;
  priority?: string;
  escalate_to_human?: string;
  unloading_delay_reason?: string;
}): string {
  if (outcome.priority === 'urgent') return 'Urgent Emergency Escalation';
  if (outcome.call_status === 'no_answer') return 'No Answer';
  if (outcome.call_status === 'busy_callback') return 'Busy / Callback Requested';
  if (outcome.call_status === 'wrong_person') return 'Wrong Person';
  if (outcome.unloaded === 'yes') {
    return outcome.escalate_to_human === 'yes' ? 'Unloaded (Ops Follow-up)' : 'Unloaded - Next Plan Given';
  }
  if (outcome.unloaded === 'no') {
    const reason = outcome.unloading_delay_reason && outcome.unloading_delay_reason !== 'none'
      ? outcome.unloading_delay_reason.replace(/_/g, ' ')
      : 'delay';
    return `Not Unloaded (${reason})`;
  }
  if (outcome.unloaded === 'on_the_way') return 'On The Way';
  return 'Connected';
}
