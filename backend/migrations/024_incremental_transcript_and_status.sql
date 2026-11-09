-- 024_incremental_transcript_and_status.sql: Add incremental transcript to calls table and normalize call status constraint
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript JSONB DEFAULT '[]'::jsonb;

-- Ensure calls status check allows canonical statuses
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (
  status IN (
    'initiated', 'dialing', 'answered', 'completed', 'no_answer', 'busy', 'failed',
    'COMPLETED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL', 'NO_RESPONSE', 'DISCONNECTED', 'FAILED'
  )
);

