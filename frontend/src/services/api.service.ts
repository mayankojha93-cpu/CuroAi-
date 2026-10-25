import type { CampaignSummary, CallRecord, Customer, CustomerCreateInput, SystemHealth, CampaignItem } from '../types';
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
  const res = await fetch(`${API_BASE}/api/health`);
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
  const res = await authFetch(`${API_BASE}/api/calls`);
  if (!res.ok) throw new Error(`Failed to fetch calls: ${res.statusText}`);
  const data = await res.json();
  return data.calls || [];
}

/**
 * Fetches full details and turn-by-turn transcript for a specific call
 */
export async function fetchCallDetail(callId: string): Promise<CallRecord> {
  const res = await authFetch(`${API_BASE}/api/calls/${callId}`);
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
  const res = await authFetch(`${API_BASE}/api/calls`, {
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
  customer_name?: string;
  company_name?: string;
  script?: string;
  language?: string;
  voice_pipeline?: string;
  address?: string;
  account_no?: string;
  subs_del_no?: string;
  service_end_date?: string;
  r_date?: string;
}

/**
 * Initiates customized developer test call with AI agent dispatch
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
    companyName?: string;
    script?: string;
    voicePipeline?: string;
    language?: string;
    accountNo?: string;
    subsDelNo?: string;
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

/**
 * Fetches test call history from PostgreSQL
 */
export async function fetchTestCallHistory(): Promise<CallRecord[]> {
  try {
    const res = await authFetch(`${API_BASE}/api/calls/test-history`);
    if (!res.ok) {
      const fallbackRes = await authFetch(`${API_BASE}/api/calls`);
      const fallbackData = await fallbackRes.json();
      return fallbackData.calls || [];
    }
    const data = await res.json();
    return data.calls || [];
  } catch {
    return [];
  }
}

/**
 * Fetches campaigns from PostgreSQL with optional status and search filters
 */
export async function fetchCampaigns(status?: string, search?: string): Promise<CampaignItem[]> {
  const params = new URLSearchParams();
  if (status && status !== 'ALL' && status !== 'All campaigns') params.set('status', status);
  if (search && search.trim()) params.set('search', search.trim());
  const queryString = params.toString() ? `?${params.toString()}` : '';
  const res = await authFetch(`${API_BASE}/api/campaigns${queryString}`);
  if (!res.ok) throw new Error(`Failed to fetch campaigns: ${res.statusText}`);
  const data = await res.json();
  return data.campaigns || [];
}

/**
 * Updates campaign status between Running, Paused, Completed, Stopped
 */
export async function updateCampaignStatus(id: string, status: string): Promise<CampaignItem> {
  const res = await authFetch(`${API_BASE}/api/campaigns/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update campaign status: ${res.statusText}`);
  }
  const data = await res.json();
  return data.campaign;
}

/**
 * Updates campaign retry settings (attempts and delay)
 */
export async function updateCampaignRetry(
  id: string,
  retryAttempts: number,
  retryDelayMinutes?: number
): Promise<{ campaign: CampaignItem; eligibleForRetryCount: number }> {
  const res = await authFetch(`${API_BASE}/api/campaigns/${id}/retry`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      retry_attempts: retryAttempts,
      retry_delay_minutes: retryDelayMinutes,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update retry settings: ${res.statusText}`);
  }
  return await res.json();
}

/**
 * Creates a new campaign
 */
export async function createCampaign(data: Partial<CampaignItem>): Promise<CampaignItem> {
  const res = await authFetch(`${API_BASE}/api/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create campaign: ${res.statusText}`);
  }
  const result = await res.json();
  return result.campaign;
}

/**
 * Fetches call records for a specific campaign
 */
export async function fetchCampaignCalls(campaignId: string): Promise<CallRecord[]> {
  const res = await authFetch(`${API_BASE}/api/campaigns/${campaignId}/calls`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.calls || [];
}

/**
 * Fetches billing balance (credits)
 */
export async function fetchBillingBalance(): Promise<{ available_credits: number; currency: string }> {
  const res = await authFetch(`${API_BASE}/api/billing/balance`);
  if (!res.ok) {
    return { available_credits: 21874, currency: 'credits' };
  }
  return res.json();
}

/**
 * Adds credits to billing balance (+1000, +5000, +10000)
 */
export async function addBillingCredits(amount: number): Promise<{ success: boolean; available_credits: number }> {
  const res = await authFetch(`${API_BASE}/api/billing/add-credits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to add credits: ${res.statusText}`);
  }
  return res.json();
}

/**
 * Starts campaign outbound calling dispatch according to rate limits
 */
export async function startCampaignCalls(campaignId: string): Promise<{
  success: boolean;
  message: string;
  campaign: CampaignItem;
  dispatchedCount: number;
}> {
  const res = await authFetch(`${API_BASE}/api/campaigns/${campaignId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to start campaign: ${res.statusText}`);
  }
  return res.json();
}

/**
 * Uploads audience contacts CSV/array to an existing campaign
 */
export async function uploadCampaignContacts(
  campaignId: string,
  contacts: (string | { phone: string; name?: string; email?: string })[]
): Promise<{
  success: boolean;
  message: string;
  campaign: CampaignItem;
  addedCount: number;
  duplicatesCount: number;
  invalidCount: number;
}> {
  const res = await authFetch(`${API_BASE}/api/campaigns/${campaignId}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contacts }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to upload contacts: ${res.statusText}`);
  }
  return res.json();
}

export interface DispositionBreakdownItem {
  name: string;
  count: number;
  percentage: number;
}

/**
 * Fetches call disposition breakdown for a campaign
 */
export async function fetchCampaignDispositions(campaignId: string): Promise<{
  expected: string[];
  dispositions: DispositionBreakdownItem[];
  totalCalls: number;
}> {
  const res = await authFetch(`${API_BASE}/api/campaigns/${campaignId}/dispositions`);
  if (!res.ok) {
    return { expected: [], dispositions: [], totalCalls: 0 };
  }
  const data = await res.json();
  return {
    expected: data.expected || [],
    dispositions: data.dispositions || [],
    totalCalls: data.totalCalls || 0,
  };
}

export interface CampaignContactRecord {
  contact_id: string;
  contact_name: string;
  contact_phone: string;
  contact_ref?: string;
  language?: string;
  attempts: number;
  max_attempts?: number;
  current_disposition?: string;
  contact_created_at: string;
  last_call_id?: string;
  call_status?: string;
  duration_seconds?: number;
  last_called_at?: string;
  recording_url?: string;
  final_disposition?: string;
  call_outcome?: string;
}

/**
 * Fetches all target audience contacts for a campaign
 */
export async function fetchCampaignContacts(campaignId: string): Promise<CampaignContactRecord[]> {
  const res = await authFetch(`${API_BASE}/api/campaigns/${campaignId}/contacts`);
  if (!res.ok) {
    throw new Error(`Failed to fetch campaign contacts: ${res.statusText}`);
  }
  const data = await res.json();
  return data.contacts || [];
}

