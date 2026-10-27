-- 014_customer_fields.sql: Add CUST_EMAIL, CUSTOMER_IDENTIFER, and alternate phone numbers
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS cust_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS customer_identifier VARCHAR(128),
  ADD COLUMN IF NOT EXISTS alternate_phones TEXT[],
  ADD COLUMN IF NOT EXISTS alternate_phone VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_customers_customer_identifier ON customers(customer_identifier);
CREATE INDEX IF NOT EXISTS idx_customers_cust_email ON customers(cust_email);
