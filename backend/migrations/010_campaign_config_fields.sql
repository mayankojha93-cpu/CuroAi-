-- 010_campaign_config_fields.sql: Adds schedule, rate limits, script, voice pipeline and call settings to campaigns

ALTER TABLE campaigns 
  ADD COLUMN IF NOT EXISTS script TEXT,
  ADD COLUMN IF NOT EXISTS language VARCHAR(64) DEFAULT 'hi-IN',
  ADD COLUMN IF NOT EXISTS voice_pipeline VARCHAR(128) DEFAULT 'Sarvam AI (Priya - hi-IN)',
  ADD COLUMN IF NOT EXISTS schedule_start_time VARCHAR(16) DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS schedule_end_time VARCHAR(16) DEFAULT '20:00',
  ADD COLUMN IF NOT EXISTS operating_days JSONB DEFAULT '["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]'::jsonb,
  ADD COLUMN IF NOT EXISTS max_concurrent_calls INT DEFAULT 5,
  ADD COLUMN IF NOT EXISTS calls_per_minute INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS retry_attempts INT DEFAULT 3,
  ADD COLUMN IF NOT EXISTS retry_delay_minutes INT DEFAULT 180,
  ADD COLUMN IF NOT EXISTS max_call_duration_minutes INT DEFAULT 5,
  ADD COLUMN IF NOT EXISTS expected_dispositions JSONB DEFAULT '["CONFIRMED_PICKUP", "NEEDS_AIRTEL_SUPPORT", "SCHEDULE_CALLBACK", "REFUSED", "WRONG_PERSON"]'::jsonb;
