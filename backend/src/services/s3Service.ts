import fs from 'fs';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { query } from '../db/index.js';

export interface S3UploadResult {
  success: boolean;
  s3Key: string;
  bucket: string;
  s3Url: string;
}

export class S3Service {
  private client: S3Client | null = null;
  private bucket: string = '';
  private region: string = 'ap-south-1';

  constructor() {
    this.bucket = env.S3_BUCKET || '';
    this.region = env.S3_REGION || 'ap-south-1';

    if (this.bucket && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      this.client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
        endpoint: env.S3_ENDPOINT || undefined,
        forcePathStyle: Boolean(env.S3_ENDPOINT),
      });
      logger.info(
        { bucket: this.bucket, region: this.region },
        'AWS S3 Service initialized successfully for call audio recording storage'
      );
    } else {
      logger.warn('AWS S3 credentials or S3_BUCKET not fully configured; S3 storage will be disabled.');
    }
  }

  public isConfigured(): boolean {
    return Boolean(this.client && this.bucket);
  }

  public getBucket(): string {
    return this.bucket;
  }

  public getRegion(): string {
    return this.region;
  }

  /**
   * Generates standard S3 object key for a call recording:
   * recordings/<callId>.<ext>
   */
  public getKeyForCall(callId: string, ext: 'mp3' | 'wav' = 'mp3'): string {
    return `recordings/${callId}.${ext}`;
  }

  /**
   * Uploads a local audio file to AWS S3.
   */
  async uploadFile(
    filePath: string,
    s3Key: string,
    contentType: string = 'audio/mpeg',
    metadata?: Record<string, string>
  ): Promise<S3UploadResult> {
    if (!this.client || !this.bucket) {
      throw new Error('S3 is not configured');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found at path: ${filePath}`);
    }

    const fileStream = fs.createReadStream(filePath);
    const stats = fs.statSync(filePath);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      Body: fileStream,
      ContentType: contentType,
      ContentLength: stats.size,
      Metadata: metadata,
    });

    await this.client.send(command);

    const s3Url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${s3Key}`;
    logger.info({ s3Key, size: stats.size, s3Url }, 'Audio recording successfully uploaded to AWS S3');

    return {
      success: true,
      s3Key,
      bucket: this.bucket,
      s3Url,
    };
  }

  /**
   * Uploads an in-memory Buffer to AWS S3.
   */
  async uploadBuffer(
    buffer: Buffer,
    s3Key: string,
    contentType: string = 'audio/mpeg',
    metadata?: Record<string, string>
  ): Promise<S3UploadResult> {
    if (!this.client || !this.bucket) {
      throw new Error('S3 is not configured');
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      Body: buffer,
      ContentType: contentType,
      ContentLength: buffer.length,
      Metadata: metadata,
    });

    await this.client.send(command);

    const s3Url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${s3Key}`;
    logger.info({ s3Key, size: buffer.length, s3Url }, 'Audio recording buffer successfully uploaded to AWS S3');

    return {
      success: true,
      s3Key,
      bucket: this.bucket,
      s3Url,
    };
  }

  /**
   * Checks whether a call recording exists in AWS S3 (checks both .mp3 and .wav).
   */
  async checkRecordingExists(
    callId: string
  ): Promise<{ exists: boolean; s3Key?: string; size?: number; contentType?: string }> {
    if (!this.client || !this.bucket) {
      return { exists: false };
    }

    const candidateKeys = [
      `recordings/${callId}.mp3`,
      `recordings/${callId}.wav`,
      `${callId}.mp3`,
      `${callId}.wav`,
    ];

    for (const key of candidateKeys) {
      try {
        const head = await this.client.send(
          new HeadObjectCommand({
            Bucket: this.bucket,
            Key: key,
          })
        );
        return {
          exists: true,
          s3Key: key,
          size: head.ContentLength,
          contentType: head.ContentType || (key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'),
        };
      } catch (err: any) {
        if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
          logger.warn({ key, err: err.message }, 'Error checking S3 recording existence');
        }
      }
    }

    return { exists: false };
  }

  /**
   * Generates a pre-signed S3 URL for browser audio playback (<audio> tag).
   * Supports native HTTP range scrubbing in browsers.
   */
  async getPresignedPlaybackUrl(s3Key: string, expiresInSeconds: number = 3600): Promise<string> {
    if (!this.client || !this.bucket) {
      throw new Error('S3 is not configured');
    }

    const isWav = s3Key.toLowerCase().endsWith('.wav');
    const contentType = isWav ? 'audio/wav' : 'audio/mpeg';

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      ResponseContentType: contentType,
      ResponseCacheControl: 'public, max-age=86400',
    });

    return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Generates a pre-signed S3 URL that triggers a direct browser file download
   * with Content-Disposition: attachment; filename="<filename>".
   */
  async getPresignedDownloadUrl(
    s3Key: string,
    downloadFilename?: string,
    expiresInSeconds: number = 3600
  ): Promise<string> {
    if (!this.client || !this.bucket) {
      throw new Error('S3 is not configured');
    }

    const filename = downloadFilename || path.basename(s3Key);
    const isWav = s3Key.toLowerCase().endsWith('.wav');
    const contentType = isWav ? 'audio/wav' : 'audio/mpeg';

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      ResponseContentType: contentType,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    });

    return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Streams an S3 object directly (supports Range requests for byte-level seekable playback).
   */
  async getS3Stream(s3Key: string, range?: string) {
    if (!this.client || !this.bucket) {
      throw new Error('S3 is not configured');
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      Range: range,
    });

    const response = await this.client.send(command);

    return {
      stream: response.Body as any,
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      contentType: response.ContentType || (s3Key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'),
      statusCode: range && response.ContentRange ? 206 : 200,
      acceptRanges: 'bytes',
    };
  }

  /**
   * Syncs existing local recordings in the recordings directory to AWS S3.
   * Updates database calls table records for each synced call.
   */
  async syncLocalRecordings(recordingsDir: string): Promise<{ uploaded: number; skipped: number; failed: number }> {
    if (!this.isConfigured()) {
      logger.warn('Cannot sync local recordings: S3 is not configured');
      return { uploaded: 0, skipped: 0, failed: 0 };
    }

    if (!fs.existsSync(recordingsDir)) {
      return { uploaded: 0, skipped: 0, failed: 0 };
    }

    const files = fs.readdirSync(recordingsDir);
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of files) {
      if (!file.endsWith('.mp3') && !file.endsWith('.wav')) continue;

      const filePath = path.join(recordingsDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.size <= 44) continue; // Skip empty wav headers or corrupt files

        const callId = path.basename(file, path.extname(file));
        const ext = file.endsWith('.mp3') ? 'mp3' : 'wav';
        const s3Key = this.getKeyForCall(callId, ext);

        // Check if already in S3
        const check = await this.checkRecordingExists(callId);
        if (check.exists && (check.size || 0) > 44) {
          skipped++;
          continue;
        }

        const contentType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
        await this.uploadFile(filePath, s3Key, contentType, { 'call-id': callId });
        uploaded++;

        // Update database record to ensure recording_url is populated and marked done
        await query(
          `UPDATE calls
           SET recording_url = $1,
               recording_download_status = 'done'
           WHERE id = $2`,
          [`/api/calls/${callId}/audio`, callId]
        ).catch(() => {});
      } catch (err: any) {
        logger.error({ file, err: err.message }, 'Failed to sync local recording to S3');
        failed++;
      }
    }

    logger.info({ uploaded, skipped, failed }, 'Completed S3 recording sync');
    return { uploaded, skipped, failed };
  }
}

export const s3Service = new S3Service();

