import type { CampaignSummary, CallRecord, Customer, CustomerCreateInput, SystemHealth } from '../types';
import { getStoredAuthToken } from '../context/AuthContext';

const API_BASE = '';

/**
 * Custom fetch wrapper that automatically appends Authorization Bearer token
 */
async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getStoredAuthToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    localStorage.removeItem('curo_auth_token');
    localStorage.removeItem('curo_auth_user');
    window.dispatchEvent(new Event('auth:unauthorized'));
  }
  return res;
}

/**
 * Checks system and database connectivity health (public)
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
  const res = await authFetch(`${API_BASE}/api/campaign/summary`);
  if (!res.ok) throw new Error(`Failed to fetch campaign summary: ${res.statusText}`);
  const data = await res.json();
  return data.summary;
}

/**
 * Fetches recent call history with latency and recording details
 */
export async function fetchRecentCalls(): Promise<CallRecord[]> {
  const res = await authFetch(`${API_BASE}/calls`);
  if (!res.ok) throw new Error(`Failed to fetch calls: ${res.statusText}`);
  const data = await res.json();
  return data.calls || [];
}

/**
 * Fetches full details and turn-by-turn transcript for a specific call
 */
export async function fetchCallDetail(callId: string): Promise<CallRecord> {
  const res = await authFetch(`${API_BASE}/calls/${callId}`);
  if (!res.ok) throw new Error(`Failed to fetch call details: ${res.statusText}`);
  const data = await res.json();
  return data.call;
}

/**
 * Fetches customer leads with attempts and disposition status
 */
export async function fetchCustomers(): Promise<Customer[]> {
  const res = await authFetch(`${API_BASE}/api/customers`);
  if (!res.ok) throw new Error(`Failed to fetch customers: ${res.statusText}`);
  const data = await res.json();
  return data.customers || [];
}

/**
 * Fetches pending leads eligible for retry under the 3-hour cooldown rule
 */
export async function fetchPendingRetries(): Promise<Customer[]> {
  const res = await authFetch(`${API_BASE}/api/retries/pending`);
  if (!res.ok) throw new Error(`Failed to fetch pending retries: ${res.statusText}`);
  const data = await res.json();
  return data.pending || [];
}

/**
 * Triggers outbound SIP call dispatched to agent Priya
 */
export async function initiateCall(customerId: string): Promise<{ id: string; status: string; roomName: string }> {
  const res = await authFetch(`${API_BASE}/calls`, {
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
  const res = await authFetch(`${API_BASE}/api/leads/import`, {
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

export interface TestCallInput {
  phone: string;
  name?: string;
  address?: string;
  account_no?: string;
  subs_del_no?: string;
  service_end_date?: string;
  r_date?: string;
  language?: string;
}

/**
 * Initiates customized developer test call with Priya AI agent dispatch
 */
export async function initiateTestCall(payload: TestCallInput): Promise<{
  success: boolean;
  message: string;
  call: {
    id: string;
    customerId: string;
    status: string;
    roomName: string;
    phone: string;
    customerName: string;
    accountNo: string;
    subsDelNo: string;
    serviceEndDate?: string;
    createdAt: string;
  };
}> {
  const res = await authFetch(`${API_BASE}/api/calls/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to initiate test call: ${res.statusText}`);
  }
  return res.json();
}
