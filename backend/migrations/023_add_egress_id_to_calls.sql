-- 023_add_egress_id_to_calls.sql
-- Add egress_id column to track LiveKit audio egress sessions

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS egress_id VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_calls_egress_id ON calls(egress_id);

