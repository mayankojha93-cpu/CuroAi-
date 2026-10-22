-- 002_airtel_campaign_schema.sql: Airtel IPTV / Wi-Fi Campaign enhancements for dispositions, retries, and call audits

-- 1. Upgrade customers table with campaign telecom fields and retry tracking
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS account_no VARCHAR(64),
  ADD COLUMN IF NOT EXISTS subs_del_no VARCHAR(64),
  ADD COLUMN IF NOT EXISTS service_end_date DATE,
  ADD COLUMN IF NOT EXISTS r_date DATE,
  ADD COLUMN IF NOT EXISTS total_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_attempt_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_disposition VARCHAR(64) DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS is_closed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_customers_retry 
  ON customers(next_attempt_time, total_attempts, is_closed);
CREATE INDEX IF NOT EXISTS idx_customers_account_no 
  ON customers(account_no);
CREATE INDEX IF NOT EXISTS idx_customers_subs_del_no 
  ON customers(subs_del_no);

-- 2. Upgrade calls table with attempt metadata, telephony statuses, recordings, and metrics
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS duration_seconds INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS call_status VARCHAR(32) DEFAULT 'initiated',
  ADD COLUMN IF NOT EXISTS recording_url TEXT,
  ADD COLUMN IF NOT EXISTS median_latency_ms INT,
  ADD COLUMN IF NOT EXISTS cost_estimate_inr NUMERIC(6, 2);

-- Loosen calls status constraint to support both LiveKit lifecycle and telephony dispositions
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (
  status IN (
    'initiated', 'dialing', 'answered', 'completed', 'no_answer', 'busy', 'failed',
    'COMPLETED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL', 'NO_RESPONSE', 'DISCONNECTED', 'FAILED'
  )
);

-- 3. Upgrade call_outcomes table with full Airtel recovery dispositions and evidence fields
ALTER TABLE call_outcomes DROP CONSTRAINT IF EXISTS call_outcomes_outcome_check;

ALTER TABLE call_outcomes
  ADD COLUMN IF NOT EXISTS identity_confirmed BOOLEAN,
  ADD COLUMN IF NOT EXISTS pickup_accepted BOOLEAN,
  ADD COLUMN IF NOT EXISTS proposed_date DATE,
  ADD COLUMN IF NOT EXISTS confirmed_date DATE,
  ADD COLUMN IF NOT EXISTS registered_address_confirmed BOOLEAN,
  ADD COLUMN IF NOT EXISTS new_address TEXT,
  ADD COLUMN IF NOT EXISTS alternate_phone VARCHAR(32),
  ADD COLUMN IF NOT EXISTS final_disposition VARCHAR(64),
  ADD COLUMN IF NOT EXISTS customer_note TEXT,
  ADD COLUMN IF NOT EXISTS escalation_required BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS transcript_reference TEXT;

CREATE INDEX IF NOT EXISTS idx_call_outcomes_final_disposition 
  ON call_outcomes(final_disposition);
