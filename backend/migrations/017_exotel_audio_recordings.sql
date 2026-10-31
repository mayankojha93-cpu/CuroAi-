-- 017_exotel_audio_recordings.sql
-- Add Exotel Call SID, duration, and recording metadata to calls

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS exotel_call_sid VARCHAR(100),
  ADD COLUMN IF NOT EXISTS recording_duration_seconds INTEGER;

CREATE INDEX IF NOT EXISTS idx_calls_exotel_sid ON calls(exotel_call_sid);
