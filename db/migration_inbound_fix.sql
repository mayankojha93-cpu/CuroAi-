-- Idempotent migration: makes the schema match what callService.ts / the agent now write.
-- Run once:  psql "$DATABASE_URL" -f db/migration_inbound_fix.sql
-- (Table/column names are inferred from your queries - compare with your real schema first.)

BEGIN;

-- 1. calls.direction (inbound/outbound) - used by registerInboundCall, sweeper, reports
ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction TEXT;
UPDATE calls SET direction = 'inbound'  WHERE direction IS NULL AND room_name LIKE 'inbound-%';
UPDATE calls SET direction = 'outbound' WHERE direction IS NULL;
ALTER TABLE calls ALTER COLUMN direction SET DEFAULT 'outbound';

-- 2. customers retry bookkeeping must exist and have sane defaults
ALTER TABLE customers ADD COLUMN IF NOT EXISTS current_disposition TEXT DEFAULT 'PENDING';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_closed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 3;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS next_attempt_time TIMESTAMPTZ;
UPDATE customers SET current_disposition = 'PENDING' WHERE current_disposition IS NULL;

-- 3. Remove duplicate inbound call rows created by the old double-registration
--    (webhook + agent each inserted one). Keeps the row that has an outcome, else the oldest.
DELETE FROM calls c
USING calls d
WHERE c.room_name = d.room_name
  AND c.id <> d.id
  AND (
        (NOT EXISTS (SELECT 1 FROM call_outcomes o WHERE o.call_id = c.id)
         AND EXISTS (SELECT 1 FROM call_outcomes o WHERE o.call_id = d.id))
     OR (NOT EXISTS (SELECT 1 FROM call_outcomes o WHERE o.call_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM call_outcomes o WHERE o.call_id = d.id)
         AND (c.created_at > d.created_at OR (c.created_at = d.created_at AND c.id > d.id)))
      );

-- 4. One call row per room, one outcome per call, one customer per phone
CREATE UNIQUE INDEX IF NOT EXISTS calls_room_name_uidx ON calls (room_name);
CREATE UNIQUE INDEX IF NOT EXISTS call_outcomes_call_id_uidx ON call_outcomes (call_id);
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_uidx ON customers (phone);

-- 5. Inbound-only customers (unknown callers) must never be dialled by the retry queue
UPDATE customers
SET is_closed = TRUE, next_attempt_time = NULL
WHERE name LIKE 'Inbound Caller (%' AND total_attempts = 0 AND is_closed = FALSE;

COMMIT;
