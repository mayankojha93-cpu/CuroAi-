import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface ExotelWssCallParams {
  callId: string;
  phone: string;
  callerId?: string;
  streamUrl?: string;
}

export interface ExotelCallResult {
  sid: string;
  status: string;
  streamSid?: string;
}

/**
 * Initiates an outbound voice AI call via Exotel's Connect API using bidirectional WSS streaming.
 * Exotel dials the target phone number, and upon answer, immediately opens a bidirectional
 * WebSocket stream to our Exotel WSS Audio Bridge.
 */
export async function initiateExotelWssCall(params: ExotelWssCallParams): Promise<ExotelCallResult> {
  const accountSid = env.EXOTEL_ACCOUNT_SID || env.EXOTEL_SID || 'curoai1m';
  const apiKey = env.EXOTEL_API_KEY || '';
  const apiToken = env.EXOTEL_API_TOKEN || env.EXOTEL_TOKEN || '';
  const subdomain = env.EXOTEL_SUBDOMAIN || 'api.in.exotel.com';

  if (!apiKey || !apiToken) {
    throw new Error('Missing EXOTEL_API_KEY or EXOTEL_API_TOKEN in environment config');
  }

  // Format recipient phone number for Indian carriers (must start with 0 or +91)
  let rawPhone = params.phone.replace(/[^0-9+]/g, '');
  let dialable = rawPhone;
  if (dialable.startsWith('+91') && dialable.length === 13) {
    dialable = `0${dialable.slice(3)}`;
  } else if (!dialable.startsWith('0') && !dialable.startsWith('+')) {
    dialable = `0${dialable}`;
  }

  // Caller ID ExoPhone
  let callerId = params.callerId || env.SIP_CALLER_ID || env.EXOTEL_CALLER_ID || '02241780517';
  if (callerId.startsWith('+91') && callerId.length === 13) {
    callerId = `0${callerId.slice(3)}`;
  }

  // Determine WebSocket Stream URL
  let streamBase = env.EXOTEL_STREAM_URL || '';
  if (!streamBase) {
    if (env.PUBLIC_WEBHOOK_URL) {
      streamBase = env.PUBLIC_WEBHOOK_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    } else {
      streamBase = 'wss://zoo-gig-voluntary-marina.trycloudflare.com';
    }
  }
  // Trim trailing slash
  streamBase = streamBase.replace(/\/+$/, '');

  const streamUrl =
    params.streamUrl ||
    `${streamBase}/api/exotel/media-stream/${encodeURIComponent(params.callId)}?callId=${encodeURIComponent(params.callId)}&phone=${encodeURIComponent(dialable)}&sample-rate=16000`;

  const httpBase = streamBase.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  const callbackUrl = `${httpBase}/api/exotel/recording-callback`;

  logger.info(
    { callId: params.callId, dialable, callerId, streamUrl },
    `📞 [EXOTEL-WSS] Initiating outbound voice stream call to ${dialable}`
  );

  const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString('base64')}`;
  const apiUrl = `https://${subdomain}/v1/Accounts/${accountSid}/Calls/connect.json`;

  const formData = new URLSearchParams({
    From: dialable,
    CallerId: callerId,
    StreamUrl: streamUrl,
    StreamType: 'bidirectional',
    CallType: 'trans',
    Record: 'true',
    CustomField: params.callId,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });

  const resText = await response.text();
  let json: any = {};
  try {
    json = JSON.parse(resText);
  } catch {
    throw new Error(`Exotel API returned non-JSON HTTP ${response.status}: ${resText.slice(0, 300)}`);
  }

  if (!response.ok) {
    const errorMsg = json?.RestException?.Message || json?.message || `HTTP ${response.status}`;
    logger.error({ callId: params.callId, errorMsg, json }, 'Exotel WSS call initiation rejected');
    throw new Error(`Exotel error: ${errorMsg}`);
  }

  const callData = json.Call || {};
  const sid = callData.Sid || callData.sid;
  const status = callData.Status || callData.status || 'in-progress';
  const streamUri = callData.SubResourceUris?.Stream || '';
  const streamSidMatch = streamUri.match(/Stream\/([^.]+)/);
  const streamSid = streamSidMatch ? streamSidMatch[1] : undefined;

  logger.info(
    { callId: params.callId, exotelCallSid: sid, status, streamSid },
    `🎉 [EXOTEL-WSS] Call placed successfully | Carrier SID: ${sid}`
  );

  return {
    sid,
    status,
    streamSid,
  };
}

/**
 * Fetches call details and audio recording from Exotel REST API.
 */
export async function fetchExotelCallDetails(
  exotelCallSid: string
): Promise<{ recordingUrl?: string; duration?: number; status?: string }> {
  const accountSid = env.EXOTEL_ACCOUNT_SID || env.EXOTEL_SID || 'curoai1m';
  const apiKey = env.EXOTEL_API_KEY || '';
  const apiToken = env.EXOTEL_API_TOKEN || env.EXOTEL_TOKEN || '';
  const subdomain = env.EXOTEL_SUBDOMAIN || 'api.in.exotel.com';

  if (!apiKey || !apiToken || !exotelCallSid) return {};

  const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString('base64')}`;
  const apiUrl = `https://${subdomain}/v1/Accounts/${accountSid}/Calls/${exotelCallSid}.json`;

  try {
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return {};
    const data = (await res.json()) as any;
    const call = data?.Call || {};
    return {
      recordingUrl: call.RecordingUrl || undefined,
      duration: call.Duration ? Number(call.Duration) : undefined,
      status: call.Status || undefined,
    };
  } catch (e: any) {
    logger.debug({ exotelCallSid, err: e?.message }, 'Failed to fetch Exotel call details');
    return {};
  }
}

