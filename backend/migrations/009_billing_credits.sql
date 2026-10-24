-- 009_billing_credits.sql: Billing accounts table to persist available credits balance

CREATE TABLE IF NOT EXISTS billing_accounts (
  id VARCHAR(64) PRIMARY KEY DEFAULT 'default',
  available_credits INT NOT NULL DEFAULT 21874,
  currency VARCHAR(16) DEFAULT 'credits',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO billing_accounts (id, available_credits)
VALUES ('default', 21874)
ON CONFLICT (id) DO NOTHING;
