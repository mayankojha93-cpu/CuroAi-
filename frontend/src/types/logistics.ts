export interface LogisticsTrip {
  id: string;
  driver_name: string;
  driver_phone: string;
  vehicle_number: string;
  lr_number: string;
  origin?: string | null;
  destination?: string | null;
  consignee?: string | null;
  material?: string | null;
  expected_unload_date?: string | null;
  current_call_round: number;
  next_assignment?: string | null;
  plant_contact_number?: string | null;
  ops_number: string;
  trip_status: string;
  last_called_at?: string | null;
  next_callback_at?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  last_call_status?: string | null;
  last_unloaded?: string | null;
  last_delay_reason?: string | null;
  last_priority?: string | null;
  last_escalate?: string | null;
  last_departure_eta?: string | null;
  last_summary?: string | null;
}

export interface LogisticsTripInput {
  driver_name: string;
  driver_phone: string;
  vehicle_number: string;
  lr_number: string;
  origin?: string;
  destination?: string;
  consignee?: string;
  material?: string;
  expected_unload_date?: string;
  current_call_round?: number;
  next_assignment?: string;
  plant_contact_number?: string;
  ops_number?: string;
  notes?: string;
}

export interface LogisticsSummary {
  total_trips: number;
  unloaded_count: number;
  in_progress_count: number;
  escalated_count: number;
  pending_count: number;
  urgent_count: number;
  high_count: number;
}

export interface LogisticsCallRecord {
  id: string;
  logistics_trip_id?: string | null;
  status: string;
  final_disposition?: string | null;
  duration_seconds?: number | null;
  median_latency_ms?: number | null;
  recording_url?: string | null;
  transcript?: Array<{ role: string; text: string; timestamp?: string }>;
  created_at: string;
  driver_name?: string;
  driver_phone?: string;
  vehicle_number?: string;
  lr_number?: string;
  origin?: string;
  destination?: string;
  consignee?: string;
  current_call_round?: number;
  logistics_call_status?: string;
  callback_time?: string;
  unloaded?: string;
  current_location?: string;
  unloading_delay_reason?: string;
  waiting_hours?: string;
  pod_signed_received?: string;
  shortage_or_damage_reported?: string;
  issue_details?: string;
  money_demanded_amount?: string;
  next_assignment_communicated?: string;
  driver_accepted_next_assignment?: string;
  driver_departure_eta?: string;
  priority?: string;
  escalate_to_human?: string;
  driver_questions_for_ops?: string;
  summary_in_english?: string;
  raw_json?: Record<string, any>;
}

export interface LogisticsEscalation {
  id: string;
  call_id: string;
  trip_id?: string | null;
  vehicle_number?: string;
  lr_number?: string;
  driver_name?: string;
  driver_phone?: string;
  consignee?: string;
  priority: string;
  escalate_to_human: string;
  issue_details?: string;
  money_demanded_amount?: string;
  driver_questions_for_ops?: string;
  summary_in_english?: string;
  recording_url?: string;
  created_at: string;
}
