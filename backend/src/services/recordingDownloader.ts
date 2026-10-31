/**
 * recordingDownloader.ts
 *
 * Background service & webhook handler to fetch, download, and serve Exotel call recordings:
 *   1. Fetches recording URL from Exotel call-details API or receives it via webhook.
 *   2. Downloads the recording MP3 to local private storage (or S3/GCS bucket).
 *   3. Writes the seekable stream endpoint URL (/api/calls/:callId/audio) back to DB.
 *   4. Automatically retries if Exotel is still processing the audio.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { query } from '../db/index.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

interface ExotelCallDetails {
  Call?: {
    Sid?: string;
    RecordingUrl?: string;
    Duration?: string | number;
    Status?: string;
  };
  Calls?: Array<{
    Sid?: string;
    RecordingUrl?: string;
    Duration?: string | number;
    Status?: string;
    StartTime?: string;
  }>;
}

/**
 * Resolves Exotel API credentials with fallbacks
 */
function getExotelCredentials() {
  const accountSid = env.EXOTEL_ACCOUNT_SID || env.EXOTEL_SID;
  const apiKey = env.EXOTEL_API_KEY || env.EXOTEL_SID;
  const apiToken = env.EXOTEL_API_TOKEN || env.EXOTEL_TOKEN;
  const subdomain = env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
  return { accountSid, apiKey, apiToken, subdomain };
}

/**
 * Fetches Exotel call details to retrieve the recording URL by CallSid.
 * Exotel REST API: GET https://{subdomain}/v1/Accounts/{SID}/Calls/{CallSid}.json
 */
export async function fetchExotelRecordingBySid(exotelCallSid: string): Promise<{ recordingUrl: string; duration?: number } | null> {
  const { accountSid, apiKey, apiToken, subdomain } = getExotelCredentials();
  if (!accountSid || !apiKey || !apiToken) {
    logger.warn('EXOTEL credentials not configured — cannot fetch recording URL by SID');
    return null;
  }

  const apiUrl = `https://${subdomain}/v1/Accounts/${accountSid}/Calls/${exotelCallSid}.json`;
  const auth = Buffer.from(`${apiKey}:${apiToken}`).toString('base64');

  return new Promise((resolve) => {
    const req = https.get(apiUrl, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const data: ExotelCallDetails = JSON.parse(body);
          const recordingUrl = data?.Call?.RecordingUrl;
          if (recordingUrl) {
            const dur = data?.Call?.Duration ? parseInt(String(data.Call.Duration), 10) : undefined;
            resolve({ recordingUrl, duration: dur });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      logger.warn({ err: e.message }, 'Exotel call-details API request failed');
      resolve(null);
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Searches Exotel for the most recent call recording matching a phone number.
 * Exotel REST API: GET https://{subdomain}/v1/Accounts/{SID}/Calls.json?To={phone}
 */
export async function fetchExotelRecordingByPhone(phone: string): Promise<{ recordingUrl: string; callSid?: string; duration?: number } | null> {
  const { accountSid, apiKey, apiToken, subdomain } = getExotelCredentials();
  if (!accountSid || !apiKey || !apiToken) {
    logger.warn('EXOTEL credentials not configured — cannot search recording by phone');
    return null;
  }

  const cleanPhone = phone.replace(/[^0-9+]/g, '');
  const apiUrl = `https://${subdomain}/v1/Accounts/${accountSid}/Calls.json?To=${encodeURIComponent(cleanPhone)}`;
  const auth = Buffer.from(`${apiKey}:${apiToken}`).toString('base64');

  return new Promise((resolve) => {
    const req = https.get(apiUrl, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const data: ExotelCallDetails = JSON.parse(body);
          const calls = data?.Calls || [];
          // Find the most recent call that has a RecordingUrl
          for (const c of calls) {
            if (c.RecordingUrl) {
              const dur = c.Duration ? parseInt(String(c.Duration), 10) : undefined;
              return resolve({ recordingUrl: c.RecordingUrl, callSid: c.Sid, duration: dur });
            }
          }
          resolve(null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      logger.warn({ err: e.message }, 'Exotel list calls API request failed');
      resolve(null);
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

export function getRecordingsDir(): string {
  if (env.RECORDING_STORAGE_DIR && fs.existsSync(env.RECORDING_STORAGE_DIR)) {
    return env.RECORDING_STORAGE_DIR;
  }
  const candidates = [
    path.resolve(process.cwd(), 'recordings'),
    path.resolve(process.cwd(), '../recordings'),
    path.resolve(__dirname, '../../../recordings'),
    path.resolve(__dirname, '../../recordings'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  const fallback = path.resolve(process.cwd(), 'recordings');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Downloads a recording from `url` and saves it to local private storage.
 * Returns the public HTTP streaming URL (/api/calls/:callId/audio) for frontend playback.
 */
export async function saveRecordingLocally(url: string, callId: string): Promise<string | null> {
  const storageDir = getRecordingsDir();

  const filename = `${callId}.mp3`;
  const filePath = path.join(storageDir, filename);
  const streamUrl = `/api/calls/${callId}/audio`;

  return new Promise((resolve) => {
    const file = fs.createWriteStream(filePath);
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, (res) => {
      // Follow redirects (Exotel S3 download links often 302 redirect)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(filePath, () => {});
        return saveRecordingLocally(res.headers.location, callId).then(resolve);
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(filePath, () => {});
        logger.warn({ callId, statusCode: res.statusCode }, 'Failed to download recording — non-200 response');
        resolve(null);
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        logger.info({ callId, filePath }, 'Recording downloaded and saved to storage');
        resolve(streamUrl);
      });
    });
    req.on('error', (e) => {
      file.close();
      fs.unlink(filePath, () => {});
      logger.warn({ callId, err: e.message }, 'Error downloading recording file');
      resolve(null);
    });
    req.setTimeout(35000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Processes and saves a recording for a call, updating DB fields.
 */
export async function processCallRecording(
  callId: string,
  recordingUrl: string,
  exotelCallSid?: string,
  durationSeconds?: number
): Promise<string | null> {
  const streamUrl = await saveRecordingLocally(recordingUrl, callId);
  if (streamUrl) {
    await query(
      `UPDATE calls
       SET recording_url = $1,
           recording_download_status = 'done',
           exotel_call_sid = COALESCE($2, exotel_call_sid),
           recording_duration_seconds = COALESCE($3, recording_duration_seconds)
       WHERE id = $4`,
      [streamUrl, exotelCallSid || null, durationSeconds || null, callId]
    );
    logger.info({ callId, streamUrl, exotelCallSid }, 'Call recording successfully saved and updated');
    return streamUrl;
  }
  return null;
}

/**
 * Main background sweeper job — runs periodically to download recordings for ended calls.
 */
export async function downloadPendingRecordings(): Promise<void> {
  const { accountSid, apiKey, apiToken } = getExotelCredentials();
  if (!accountSid || !apiKey || !apiToken) {
    return; // Exotel credentials not configured yet
  }

  const res = await query(
    `SELECT c.id, c.sip_call_id, c.exotel_call_sid, c.recording_url, c.ended_at,
            COALESCE(cust.phone, rl.phone) as phone
     FROM calls c
     LEFT JOIN customers cust ON c.customer_id = cust.id
     LEFT JOIN real_estate_leads rl ON c.re_lead_id = rl.id
     WHERE c.recording_download_status IN ('pending', 'failed')
       AND c.ended_at IS NOT NULL
       AND c.ended_at > NOW() - INTERVAL '24 hours'
       AND c.recording_url IS NULL
     ORDER BY c.ended_at ASC
     LIMIT 20`
  );

  if (res.rows.length === 0) return;

  logger.info({ count: res.rows.length }, 'Recording downloader: processing pending calls');

  for (const row of res.rows) {
    const { id: callId, exotel_call_sid: exotelSid, phone } = row;

    try {
      await query(
        `UPDATE calls SET recording_download_status = 'downloading' WHERE id = $1`,
        [callId]
      );

      let exotelData: { recordingUrl: string; callSid?: string; duration?: number } | null = null;

      // 1. If we have Exotel CallSid, query directly
      if (exotelSid) {
        exotelData = await fetchExotelRecordingBySid(exotelSid);
      }

      // 2. Fall back to phone number search if no CallSid
      if (!exotelData && phone) {
        exotelData = await fetchExotelRecordingByPhone(phone);
      }

      if (!exotelData || !exotelData.recordingUrl) {
        // Not ready yet (Exotel takes 1-5 mins after call)
        await query(
          `UPDATE calls SET recording_download_status = 'pending' WHERE id = $1`,
          [callId]
        );
        continue;
      }

      // 3. Download and save
      const saved = await processCallRecording(
        callId,
        exotelData.recordingUrl,
        exotelData.callSid || exotelSid,
        exotelData.duration
      );

      if (!saved) {
        await query(
          `UPDATE calls SET recording_download_status = 'failed' WHERE id = $1`,
          [callId]
        );
      }
    } catch (err: any) {
      logger.error({ callId, err: err.message }, 'Unexpected error in recording downloader');
      await query(
        `UPDATE calls SET recording_download_status = 'failed' WHERE id = $1`,
        [callId]
      ).catch(() => {});
    }
  }
}
