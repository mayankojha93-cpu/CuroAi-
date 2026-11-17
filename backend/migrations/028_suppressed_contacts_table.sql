-- 028_suppressed_contacts_table.sql
-- Ensure suppressed_contacts table exists for DND / DNC compliance scrubbing.

CREATE TABLE IF NOT EXISTS suppressed_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(32) NOT NULL,
  reason VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppressed_contacts_phone ON suppressed_contacts(phone);
