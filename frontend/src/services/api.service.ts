import type { CampaignSummary, CallRecord, Customer, CustomerCreateInput, SystemHealth } from '../types';

const API_BASE = '';

/**
 * Checks system and database connectivity health
 */
export async function fetchHealth(): Promise<SystemHealth> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.statusText}`);
  return res.json();
}

/**
 * Fetches the audited Airtel IP TV Campaign Summary (MIS)
 */
export async function fetchCampaignSummary(): Promise<CampaignSummary> {
  const res = await fetch(`${API_BASE}/api/campaign/summary`);
  if (!res.ok) throw new Error(`Failed to fetch campaign summary: ${res.statusText}`);
  const data = await res.json();
  return data.summary;
}

/**
 * Fetches recent call history with latency and recording details
 */
export async function fetchRecentCalls(): Promise<CallRecord[]> {
  const res = await fetch(`${API_BASE}/calls`);
  if (!res.ok) throw new Error(`Failed to fetch calls: ${res.statusText}`);
  const data = await res.json();
  return data.calls || [];
}

/**
 * Fetches full details and turn-by-turn transcript for a specific call
 */
export async function fetchCallDetail(callId: string): Promise<CallRecord> {
  const res = await fetch(`${API_BASE}/calls/${callId}`);
  if (!res.ok) throw new Error(`Failed to fetch call details: ${res.statusText}`);
  const data = await res.json();
  return data.call;
}

/**
 * Fetches customer leads with attempts and disposition status
 */
export async function fetchCustomers(): Promise<Customer[]> {
  const res = await fetch(`${API_BASE}/api/customers`);
  if (!res.ok) throw new Error(`Failed to fetch customers: ${res.statusText}`);
  const data = await res.json();
  return data.customers || [];
}

/**
 * Fetches pending leads eligible for retry under the 3-hour cooldown rule
 */
export async function fetchPendingRetries(): Promise<Customer[]> {
  const res = await fetch(`${API_BASE}/api/retries/pending`);
  if (!res.ok) throw new Error(`Failed to fetch pending retries: ${res.statusText}`);
  const data = await res.json();
  return data.pending || [];
}

/**
 * Triggers outbound SIP call dispatched to agent Priya
 */
export async function initiateCall(customerId: string): Promise<{ id: string; status: string; roomName: string }> {
  const res = await fetch(`${API_BASE}/calls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to initiate call: ${res.statusText}`);
  }
  const data = await res.json();
  return data.call;
}

/**
 * Imports campaign leads batch
 */
export async function importLeads(leads: Partial<CustomerCreateInput>[]): Promise<{ count: number }> {
  const res = await fetch(`${API_BASE}/api/leads/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leads }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to import leads: ${res.statusText}`);
  }
  return res.json();
}
