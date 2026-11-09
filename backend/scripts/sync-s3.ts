import { s3Service } from '../src/services/s3Service.js';
import { getRecordingsDir } from '../src/services/recordingDownloader.js';
import { logger } from '../src/config/logger.js';

async function main() {
  console.log('🔄 Starting manual S3 recording synchronization...');
  const dir = getRecordingsDir();
  console.log(`📁 Scanning recordings directory: ${dir}`);

  const result = await s3Service.syncLocalRecordings(dir);
  console.log('✅ S3 Sync Completed:');
  console.log(`   - Uploaded to S3: ${result.uploaded}`);
  console.log(`   - Already in S3:  ${result.skipped}`);
  console.log(`   - Failed:         ${result.failed}`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'S3 sync script failed');
  process.exit(1);
});
