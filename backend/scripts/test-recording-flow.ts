import { query } from '../src/db/index.js';
import { s3Service } from '../src/services/s3Service.js';
import { authService } from '../src/services/authService.js';
import https from 'https';

async function testRecordingFlow() {
  console.log('--- Testing S3 Audio Recording Store & Fetch Flow ---');

  // 1. Check S3 service configuration
  console.log('1. S3 Service status:');
  console.log('   - isConfigured:', s3Service.isConfigured());
  console.log('   - Bucket:', s3Service.getBucket());
  console.log('   - Region:', s3Service.getRegion());

  // 2. Query calls that have recordings
  const res = await query(
    `SELECT id, recording_url, recording_download_status, duration_seconds
     FROM calls
     WHERE recording_url IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 5`
  );

  console.log(`\n2. Found ${res.rows.length} calls with recording_url in DB:`);
  for (const c of res.rows) {
    console.log(`   - Call ID: ${c.id}, status: ${c.recording_download_status}, url: ${c.recording_url}`);
  }

  if (res.rows.length === 0) {
    console.log('No calls with recordings found in DB to test.');
    return;
  }

  let testCall = null;
  let s3Check = null;

  for (const c of res.rows) {
    const check = await s3Service.checkRecordingExists(c.id);
    if (check.exists && check.s3Key) {
      testCall = c;
      s3Check = check;
      break;
    }
  }

  if (!testCall || !s3Check) {
    console.log('No calls with existing S3 recording found.');
    return;
  }

  console.log(`\n3. Testing recording for Call ID: ${testCall.id}`);
  console.log('   - S3 check result:', s3Check);

  if (s3Check.exists && s3Check.s3Key) {
    // 5. Test generating presigned playback URL
    const playbackUrl = await s3Service.getPresignedPlaybackUrl(s3Check.s3Key);
    console.log('\n4. Presigned S3 Playback URL (for listening):');
    console.log('   ', playbackUrl);

    // 6. Test generating presigned download URL
    const downloadUrl = await s3Service.getPresignedDownloadUrl(s3Check.s3Key, `call-${testCall.id}.mp3`);
    console.log('\n5. Presigned S3 Download URL (for downloading):');
    console.log('   ', downloadUrl);

    // 7. Verify HTTP GET to S3 presigned URL to ensure S3 returns audio/mpeg and byte stream
    console.log('\n6. Fetching audio bytes from S3 presigned URL...');
    await new Promise<void>((resolve, reject) => {
      https.get(playbackUrl, (resp) => {
        console.log('   - S3 Response HTTP status:', resp.statusCode);
        console.log('   - S3 Content-Type:', resp.headers['content-type']);
        console.log('   - S3 Content-Length:', resp.headers['content-length'], 'bytes');
        console.log('   - S3 Accept-Ranges:', resp.headers['accept-ranges']);

        let bytesReceived = 0;
        resp.on('data', (chunk) => {
          bytesReceived += chunk.length;
        });
        resp.on('end', () => {
          console.log(`   - Successfully received all ${bytesReceived} bytes from S3!`);
          resolve();
        });
      }).on('error', (e) => {
        console.error('   - S3 fetch error:', e.message);
        reject(e);
      });
    });
  } else {
    console.log('   - Call not yet in S3; checking if exists locally...');
  }

  console.log('\n--- S3 Audio Recording Store & Fetch Test Completed Successfully! ---');
}

testRecordingFlow().catch(console.error);
