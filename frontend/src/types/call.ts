export interface TranscriptTurn {
  role: 'agent' | 'user' | string;
  message: string;
  timestamp?: number;
}

export interface LatencyBreakdown {
  llm_ttft_ms?: number;
  tts_ttfb_ms?: number;
  e2e_latency_ms?: number;
}

export interface CallRecord {
  id: string;
  customer_id: string;
  customer_name?: string;
  customer_phone?: string;
  customer_address?: string;
  account_no?: string;
  subs_del_no?: string;
  service_end_date?: string;
  total_attempts?: number;
  status: string;
  call_status?: string;
  attempt_number?: number;
  duration_seconds?: number;
  median_latency_ms?: number;
  cost_estimate_inr?: string | number;
  recording_url?: string | null;
  room_name: string;
  sip_call_id?: string | null;
  failure_reason?: string | null;
  outcome?: string;
  final_disposition?: string;
  pickup_date?: string;
  confirmed_date?: string;
  proposed_date?: string;
  address_confirmed?: boolean;
  new_address?: string;
  customer_note?: string;
  escalation_required?: boolean;
  transcript?: TranscriptTurn[];
  created_at: string;
  answered_at?: string | null;
  ended_at?: string | null;
}
