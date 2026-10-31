-- 015_customer_extended_fields.sql: Add extended customer columns from Airtel audience CSV upload and report
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS pincode VARCHAR(32),
  ADD COLUMN IF NOT EXISTS zone VARCHAR(64),
  ADD COLUMN IF NOT EXISTS town_flag VARCHAR(64),
  ADD COLUMN IF NOT EXISTS service_city VARCHAR(128),
  ADD COLUMN IF NOT EXISTS disconnection_reason TEXT,
  ADD COLUMN IF NOT EXISTS circle_new VARCHAR(64),
  ADD COLUMN IF NOT EXISTS circle_new20 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS allocated_to VARCHAR(128),
  ADD COLUMN IF NOT EXISTS check_status VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_customers_pincode ON customers(pincode);
CREATE INDEX IF NOT EXISTS idx_customers_zone ON customers(zone);
CREATE INDEX IF NOT EXISTS idx_customers_town_flag ON customers(town_flag);
