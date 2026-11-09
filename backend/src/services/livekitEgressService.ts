import { EgressClient, EncodedFileOutput, EncodedFileType, S3Upload } from 'livekit-server-sdk';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { query } from '../db/index.js';

class LiveKitEgressService {
  private egressClient: EgressClient | null = null;

  constructor() {
    if (env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
      this.egressClient = new EgressClient(
        env.LIVEKIT_URL,
        env.LIVEKIT_API_KEY,
        env.LIVEKIT_API_SECRET
      );
    }
  }

  /**
   * Checks whether AWS S3 / Object storage is configured for LiveKit Cloud Egress.
   */
  public hasS3Storage(): boolean {
    return Boolean(
      env.S3_BUCKET &&
      ((env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || env.LIVEKIT_EGRESS_ENABLED === 'true')
    );
  }

  /**
   * Starts an audio-only composite egress for a LiveKit room.
   * If S3 credentials are configured, LiveKit Cloud records and uploads directly to S3.
   * If S3 is not configured yet, records via local agent audio capture.
   */
  async startAudioRecording(roomName: string, callId: string): Promise<string | null> {
    if (!this.egressClient) {
      logger.warn({ callId }, 'LiveKit credentials missing; cannot start LiveKit Egress');
      return null;
    }

    if (!this.hasS3Storage()) {
      logger.info(
        { callId, roomName },
        'AWS S3 not configured in .env; call recording is handled locally in ./recordings via agent audio capture.'
      );
      return null;
    }

    try {
      const s3Upload = new S3Upload({
        accessKey: env.AWS_ACCESS_KEY_ID,
        secret: env.AWS_SECRET_ACCESS_KEY,
        region: env.S3_REGION || 'us-east-1',
        endpoint: env.S3_ENDPOINT || undefined,
        bucket: env.S3_BUCKET,
        forcePathStyle: Boolean(env.S3_ENDPOINT),
      });

      const file = new EncodedFileOutput({
        fileType: EncodedFileType.MP3,
        filepath: `recordings/${callId}.mp3`,
        output: {
          case: 's3',
          value: s3Upload,
        },
      });

      logger.info({ roomName, callId, bucket: env.S3_BUCKET }, 'Starting LiveKit RoomComposite Audio Egress');
      const info = await this.egressClient.startRoomCompositeEgress(
        roomName,
        { file },
        { audioOnly: true }
      );

      const egressId = info.egressId;
      logger.info({ callId, egressId, roomName }, 'LiveKit audio egress started successfully');

      await query(
        `UPDATE calls
         SET egress_id = $1,
             recording_download_status = 'recording'
         WHERE id = $2`,
        [egressId, callId]
      );

      return egressId;
    } catch (err: any) {
      logger.error({ callId, roomName, err: err?.message || err }, 'Failed to start LiveKit Egress');
      return null;
    }
  }

  /**
   * Stops an active egress session if needed.
   */
  async stopAudioRecording(egressId: string): Promise<void> {
    if (!this.egressClient || !egressId) return;
    try {
      await this.egressClient.stopEgress(egressId);
      logger.info({ egressId }, 'LiveKit audio egress stopped');
    } catch (err: any) {
      logger.warn({ egressId, err: err?.message }, 'Error stopping LiveKit audio egress');
    }
  }

  /**
   * Handles egress_ended and egress_updated events received from LiveKit Webhook.
   */
  async handleEgressWebhook(egressInfo: any): Promise<void> {
    if (!egressInfo) return;

    const egressId = egressInfo.egressId || egressInfo.egress_id;
    const roomName = egressInfo.roomName || egressInfo.room_name || '';
    const status = egressInfo.status;

    logger.info({ egressId, roomName, status }, 'Processing LiveKit egress webhook event');

    // Extract callId from roomName (e.g. call-<id> or re-call-<id>)
    let callId: string | null = null;
    if (roomName.startsWith('re-call-')) {
      callId = roomName.replace('re-call-', '');
    } else if (roomName.startsWith('call-')) {
      callId = roomName.replace('call-', '');
    } else if (egressId) {
      const dbRes = await query('SELECT id FROM calls WHERE egress_id = $1', [egressId]);
      if (dbRes.rows.length > 0) callId = dbRes.rows[0].id;
    }

    if (!callId) {
      logger.warn({ egressId, roomName }, 'Could not identify callId for egress webhook');
      return;
    }

    // Check results
    const fileResults = egressInfo.fileResults || egressInfo.file_results || [];
    const firstResult = fileResults[0] || egressInfo.file;

    if (firstResult) {
      const location = firstResult.location || firstResult.filename || firstResult.download_url;
      const durationSeconds = firstResult.duration
        ? Math.round(Number(firstResult.duration) > 1000000 ? Number(firstResult.duration) / 1000000000 : Number(firstResult.duration))
        : null;

      logger.info({ callId, location, durationSeconds }, 'Egress completed with file output');

      await query(
        `UPDATE calls
         SET recording_url = COALESCE($1, recording_url),
             recording_download_status = 'done',
             recording_duration_seconds = COALESCE($2, recording_duration_seconds)
         WHERE id = $3`,
        [location || `/api/calls/${callId}/audio`, durationSeconds, callId]
      );
    } else if (status === 'EGRESS_FAILED' || status === 3) {
      const errorMsg = egressInfo.error || 'LiveKit Egress processing failed';
      logger.error({ callId, egressId, errorMsg }, 'LiveKit Egress failed');
      await query(
        `UPDATE calls
         SET recording_download_status = 'failed'
         WHERE id = $1 AND recording_url IS NULL`,
        [callId]
      );
    }
  }
}

export const livekitEgressService = new LiveKitEgressService();

