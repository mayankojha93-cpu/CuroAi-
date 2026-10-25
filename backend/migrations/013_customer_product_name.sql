-- 013_customer_product_name.sql: Add product_name column to customers for report generation

ALTER TABLE customers ADD COLUMN IF NOT EXISTS product_name VARCHAR(255) DEFAULT 'Airtel IP TV';
UPDATE customers SET product_name = 'Airtel IP TV' WHERE product_name IS NULL;
