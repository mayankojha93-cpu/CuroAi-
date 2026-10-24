-- 006_campaigns.sql: Voice Campaigns table supporting Running, Paused, Completed, Stopped stages

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED', 'Running', 'Paused', 'Completed', 'Stopped')),
  service VARCHAR(64) DEFAULT 'curoai_service',
  progress_percent INT DEFAULT 0,
  total_contacts INT DEFAULT 0,
  unique_called INT DEFAULT 0,
  successful_calls INT DEFAULT 0,
  failed_calls INT DEFAULT 0,
  remaining_calls INT DEFAULT 0,
  credits_used INT DEFAULT 0,
  total_credits INT DEFAULT 0,
  execution_date VARCHAR(64) DEFAULT TO_CHAR(NOW(), 'DD Mon YYYY'),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at DESC);

-- Link campaigns to customers and calls
ALTER TABLE customers ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_campaign_id ON customers(campaign_id);
CREATE INDEX IF NOT EXISTS idx_calls_campaign_id ON calls(campaign_id);

-- Seed initial voice campaigns with real metadata
INSERT INTO campaigns (id, name, status, description, total_contacts, unique_called, successful_calls, failed_calls, remaining_calls, credits_used, total_credits, progress_percent, execution_date)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'CuroAI V5 Router Hindi V3 - 07 Oct 2026 - LANE_B', 'COMPLETED', 'Our future allocation Hindi test with English switching. Uses a three-way model for all unique contacts.', 317, 317, 288, 30, 0, 0, 317, 100, '7 Oct 2026'),
  ('c1000000-0000-0000-0000-000000000002', 'CuroAI WiFi Router Hindi V3 - 07 Oct 2026 - LANE_A', 'COMPLETED', 'Our native allocation pilot first-run English switching with CuroAI flow and voice quality.', 597, 557, 333, 224, 0, 0, 597, 100, '7 Oct 2026'),
  ('c1000000-0000-0000-0000-000000000003', 'CuroAI IPTV Second Priority Zone V5 - 30 Sep 2026', 'COMPLETED', 'Final high priority allocation for IPTV unique phones with regional language selection.', 1292, 1291, 1073, 218, 0, 0, 1292, 100, '30 Sept 2026'),
  ('c1000000-0000-0000-0000-000000000004', 'CuroAI STB Sarvam Language Barrier Recovery - 11 Sep 2026', 'PAUSED', 'Recovery campaign for audited Language Barrier contacts from the 9–10 September runs.', 190, 140, 98, 42, 50, 0, 190, 74, '11 Sep 2026'),
  ('c1000000-0000-0000-0000-000000000005', 'CuroAI STB Sarvam Multilingual 100 - 11 Sep 2026', 'COMPLETED', '100 zero-attempt South India contacts, stratified equally across regional languages.', 100, 100, 82, 18, 0, 0, 100, 100, '11 Sep 2026'),
  ('c1000000-0000-0000-0000-000000000006', 'CuroAI STB V5 Remaining B - 12,496 - 10 Sep 2026', 'PAUSED', 'Untouched remainder of the active service recovery list; scheduled for 08:00 IST.', 12496, 12396, 7840, 4556, 100, 0, 12496, 99, '10 Sep 2026')
ON CONFLICT (id) DO NOTHING;
