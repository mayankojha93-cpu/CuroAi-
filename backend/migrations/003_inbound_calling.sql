-- 003_inbound_calling.sql: Add support for inbound calling tracking and flexible customer assignment

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS direction VARCHAR(16) NOT NULL DEFAULT 'outbound';

-- Allow customer_id to be nullable for unrecognized inbound callers
ALTER TABLE calls
  ALTER COLUMN customer_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calls_direction ON calls(direction);
