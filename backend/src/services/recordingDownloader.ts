/**
 * recordingDownloader.ts
 *
 * Background service that fulfils the spec (Section 6 — "Where recordings are stored"):
 *   1. When the call ends, the Backend waits for the recording (appears 1–15 min after call).
 *   2. Downloads the recording from Exotel's call-details API (valid for 24 h).
 *   3. Saves it to private storage and writes `recording_url` back to DB.
 *   4. If not ready yet, the download is retried later (called every 5 min by the sweeper).
 *
 * Storage note: configure RECORDING_STORAGE_DIR in .env for the local path
 * (or swap `saveRecordingLocally` for an S3 / GCS upload in production).
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { query } from '../db/index.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/** Exotel call-details API response shape (subset). */
interface ExotelCallDetails {
  Call?: {
    RecordingUrl?: string;
    Status?: string;
  };
}

/**
 * Fetches Exotel call details to retrieve the recording URL.
 * Exotel REST API: GET https://api.exotel.com/v1/Accounts/{SID}/Calls/{CallSid}.json
 */
async function fetchExotelRecordingUrl(exotelCallSid: string): Promise<string | null> {
  const exotelSid = env.EXOTEL_SID;
  const exotelToken = env.EXOTEL_TOKEN;

  if (!exotelSid || !exotelToken) {
    logger.warn('EXOTEL_SID / EXOTEL_TOKEN not configured — cannot fetch recording URL from Exotel');
    return null;
  }

  const apiUrl = `https://api.exotel.com/v1/Accounts/${exotelSid}/Calls/${exotelCallSid}.json`;
  const auth = Buffer.from(`${exotelSid}:${exotelToken}`).toString('base64');

  return new Promise((resolve) => {
    const req = https.get(apiUrl, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const data: ExotelCallDetails = JSON.parse(body);
          resolve(data?.Call?.RecordingUrl || null);
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
 * Downloads a recording from `url` and saves it to local storage.
 * Returns the local file path (which becomes the stored `recording_url`).
 *
 * In production, replace the local write with an upload to S3 / GCS
 * and return the bucket URL instead.
 */
async function saveRecordingLocally(url: string, callId: string): Promise<string | null> {
  const storageDir = env.RECORDING_STORAGE_DIR || path.join(process.cwd(), 'recordings');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const ext = '.mp3';
  const filename = `${callId}${ext}`;
  const filePath = path.join(storageDir, filename);
  const fileUrl = `file://${filePath}`; // swap for https:// bucket URL in prod

  return new Promise((resolve) => {
    const file = fs.createWriteStream(filePath);
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, (res) => {
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
        logger.info({ callId, filePath }, 'Recording downloaded and saved to private storage');
        resolve(fileUrl);
      });
    });
    req.on('error', (e) => {
      file.close();
      fs.unlink(filePath, () => {});
      logger.warn({ callId, err: e.message }, 'Error downloading recording file');
      resolve(null);
    });
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Main job — called every 5 minutes by the backend sweeper.
 *
 * Finds completed calls that:
 *   - Ended within the last 24 hours (Exotel recording still valid)
 *   - Have no `recording_url` yet (or download previously failed)
 *   - Have a `sip_call_id` to query Exotel with
 */
export async function downloadPendingRecordings(): Promise<void> {
  // Find calls that need recording download
  const res = await query(
    `SELECT id, sip_call_id, recording_url, ended_at
     FROM calls
     WHERE recording_download_status IN ('pending', 'failed')
       AND ended_at IS NOT NULL
       AND ended_at > NOW() - INTERVAL '24 hours'
       AND sip_call_id IS NOT NULL
       AND recording_url IS NULL
     ORDER BY ended_at ASC
     LIMIT 20`
  );

  if (res.rows.length === 0) return;

  logger.info({ count: res.rows.length }, 'Recording downloader: processing pending calls');

  for (const row of res.rows) {
    const { id: callId, sip_call_id: sipCallId } = row;

    try {
      // Mark as 'downloading' to prevent parallel jobs from picking it up
      await query(
        `UPDATE calls SET recording_download_status = 'downloading' WHERE id = $1`,
        [callId]
      );

      // 1. Fetch recording URL from Exotel call-details API
      const exotelUrl = await fetchExotelRecordingUrl(sipCallId);

      if (!exotelUrl) {
        // Not ready yet (appears 1–15 min after call per spec) — set back to 'pending' for retry
        await query(
          `UPDATE calls SET recording_download_status = 'pending' WHERE id = $1`,
          [callId]
        );
        logger.debug({ callId, sipCallId }, 'Recording not available yet from Exotel — will retry');
        continue;
      }

      // 2. Download and save to private storage
      const storedUrl = await saveRecordingLocally(exotelUrl, callId);

      if (!storedUrl) {
        await query(
          `UPDATE calls SET recording_download_status = 'failed' WHERE id = $1`,
          [callId]
        );
        logger.warn({ callId }, 'Recording download failed — marked for retry');
        continue;
      }

      // 3. Write recording_url back to DB
      await query(
        `UPDATE calls
         SET recording_url = $1,
             recording_download_status = 'done'
         WHERE id = $2`,
        [storedUrl, callId]
      );

      logger.info({ callId, storedUrl }, 'Recording saved to private storage and URL written to DB');

    } catch (err: any) {
      logger.error({ callId, err: err.message }, 'Unexpected error in recording downloader');
      await query(
        `UPDATE calls SET recording_download_status = 'failed' WHERE id = $1`,
        [callId]
      ).catch(() => {});
    }
  }
}
