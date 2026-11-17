-- 027_add_category_to_real_estate_leads.sql
-- Add category column to real_estate_leads, calls, and customers tables
-- to support predefined property category (Residential / Commercial) from audience CSV uploads.

-- 1. Add category column to real_estate_leads
ALTER TABLE real_estate_leads
  ADD COLUMN IF NOT EXISTS category VARCHAR(32);

-- 2. Add category column to calls
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS category VARCHAR(32);

-- 3. Add category column to customers
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS category VARCHAR(32);

-- 4. Create index on category for fast filtering
CREATE INDEX IF NOT EXISTS idx_re_leads_category ON real_estate_leads(category);

-- 5. Backfill category for existing real_estate_leads from real_estate_properties if available
UPDATE real_estate_leads rl
SET category = rp.category
FROM (
  SELECT DISTINCT ON (lead_id) lead_id, category
  FROM real_estate_properties
  WHERE category IS NOT NULL
  ORDER BY lead_id, created_at DESC
) rp
WHERE rl.id = rp.lead_id AND rl.category IS NULL;
