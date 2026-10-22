-- 004_recording_download_tracking.sql
-- Adds a status column to track async Exotel recording download lifecycle.
-- Per spec section 6: recording URL from Exotel is only valid for 24h;
-- backend must download and store to private bucket, then write recording_url.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS recording_download_status VARCHAR(20) NOT NULL DEFAULT 'pending';

-- Index for the recording downloader job to quickly find pending calls
CREATE INDEX IF NOT EXISTS idx_calls_recording_download
  ON calls(recording_download_status, ended_at)
  WHERE recording_download_status IN ('pending', 'failed');
