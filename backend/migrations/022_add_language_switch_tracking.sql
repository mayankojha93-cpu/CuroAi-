-- 022_add_language_switch_tracking.sql: Track language selection and one-time language switch status across calls and outcomes

-- 1. Add language tracking columns to calls table
ALTER TABLE calls ADD COLUMN IF NOT EXISTS language VARCHAR(32);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS initial_language VARCHAR(32);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS language_switched BOOLEAN DEFAULT FALSE;

-- 2. Add language tracking columns to call_outcomes table
ALTER TABLE call_outcomes ADD COLUMN IF NOT EXISTS language VARCHAR(32);
ALTER TABLE call_outcomes ADD COLUMN IF NOT EXISTS initial_language VARCHAR(32);
ALTER TABLE call_outcomes ADD COLUMN IF NOT EXISTS language_switched BOOLEAN DEFAULT FALSE;

-- 3. Add language tracking columns to real_estate_outcomes table
ALTER TABLE real_estate_outcomes ADD COLUMN IF NOT EXISTS language VARCHAR(32);
ALTER TABLE real_estate_outcomes ADD COLUMN IF NOT EXISTS initial_language VARCHAR(32);
ALTER TABLE real_estate_outcomes ADD COLUMN IF NOT EXISTS language_switched BOOLEAN DEFAULT FALSE;

-- 4. Backfill existing calls
UPDATE calls c
SET language = COALESCE(c.language, cust.language, 'hi'),
    initial_language = COALESCE(c.initial_language, cust.language, 'hi'),
    language_switched = COALESCE(c.language_switched, FALSE)
FROM customers cust
WHERE c.customer_id = cust.id AND c.language IS NULL;

UPDATE calls c
SET language = COALESCE(c.language, rl.preferred_language, 'hi'),
    initial_language = COALESCE(c.initial_language, rl.preferred_language, 'hi'),
    language_switched = COALESCE(c.language_switched, FALSE)
FROM real_estate_leads rl
WHERE c.re_lead_id = rl.id AND c.language IS NULL;

UPDATE calls
SET language = 'hi', initial_language = 'hi', language_switched = FALSE
WHERE language IS NULL;

