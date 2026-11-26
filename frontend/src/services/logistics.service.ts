import { getStoredAuthToken } from '../context/AuthContext';
import type {
  LogisticsCallRecord,
  LogisticsEscalation,
  LogisticsSummary,
  LogisticsTrip,
  LogisticsTripInput,
} from '../types/logistics';

async function logisticsFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getStoredAuthToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers, cache: 'no-store' });
  if (res.status === 401) {
    localStorage.removeItem('curo_auth_token');
    localStorage.removeItem('curo_auth_user');
    window.dispatchEvent(new Event('auth:unauthorized'));
  }
  return res;
}

export async function fetchLogisticsSummary(): Promise<LogisticsSummary> {
  const res = await logisticsFetch('/api/logistics/summary');
  if (!res.ok) throw new Error('Failed to fetch logistics summary');
  const data = await res.json();
  return data.summary;
}

export async function fetchLogisticsTrips(status?: string): Promise<LogisticsTrip[]> {
  const qs = status && status !== 'ALL' ? `?status=${encodeURIComponent(status)}` : '';
  const res = await logisticsFetch(`/api/logistics/trips${qs}`);
  if (!res.ok) throw new Error('Failed to fetch logistics trips');
  const data = await res.json();
  return data.trips || [];
}

export async function createLogisticsTrip(payload: LogisticsTripInput): Promise<LogisticsTrip> {
  const res = await logisticsFetch('/api/logistics/trips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create trip');
  }
  const data = await res.json();
  return data.trip;
}

export async function initiateLogisticsTestCall(payload: LogisticsTripInput): Promise<{ call: any; trip: LogisticsTrip }> {
  const res = await logisticsFetch('/api/logistics/calls/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to initiate logistics call');
  }
  return res.json();
}

export async function initiateLogisticsCall(tripId: string, callRound?: number): Promise<{ call: any; trip: LogisticsTrip }> {
  const res = await logisticsFetch('/api/logistics/calls/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tripId, callRound }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to place driver call');
  }
  return res.json();
}

export async function fetchLogisticsCalls(): Promise<LogisticsCallRecord[]> {
  const res = await logisticsFetch('/api/logistics/calls');
  if (!res.ok) throw new Error('Failed to fetch logistics calls');
  const data = await res.json();
  return data.calls || [];
}

export async function fetchLogisticsEscalations(): Promise<LogisticsEscalation[]> {
  const res = await logisticsFetch('/api/logistics/escalations');
  if (!res.ok) throw new Error('Failed to fetch logistics escalations');
  const data = await res.json();
  return data.escalations || [];
}
