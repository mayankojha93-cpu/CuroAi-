-- 012_test_calls_fields.sql: Support Script, Company / Org Name, Voice Pipeline, and Test Call tracking

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS script VARCHAR(128),
  ADD COLUMN IF NOT EXISTS company_name VARCHAR(128),
  ADD COLUMN IF NOT EXISTS voice_pipeline VARCHAR(128),
  ADD COLUMN IF NOT EXISTS is_test_call BOOLEAN DEFAULT FALSE;

-- Ensure calls have realistic script mappings
UPDATE calls SET script = 'Trump_towers_india' WHERE script IS NULL AND (id = 'b2000000-0000-0000-0000-000000000001' OR id = 'b2000000-0000-0000-0000-000000000002');
UPDATE calls SET script = 'Ratnafin_machinery_loan' WHERE script IS NULL AND (id IN ('b2000000-0000-0000-0000-000000000003', 'b2000000-0000-0000-0000-000000000004', 'b2000000-0000-0000-0000-000000000005', 'b2000000-0000-0000-0000-000000000006'));
UPDATE calls SET script = 'airtel_router_return' WHERE script IS NULL;

-- Mark seeded sample calls as test calls so test call history shows actual records immediately
UPDATE calls SET is_test_call = TRUE WHERE id IN (
  'b2000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000002',
  'b2000000-0000-0000-0000-000000000003',
  'b2000000-0000-0000-0000-000000000004',
  'b2000000-0000-0000-0000-000000000005',
  'b2000000-0000-0000-0000-000000000006'
);
