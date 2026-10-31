-- 018_user_pipeline_access.sql: Multi-tenant Pipeline Isolation
-- Grants admin@curoai.in access ONLY to Airtel Telecom pipeline
-- Grants estate.admin@curoai.in access ONLY to Real Estate (My Estate Finder) pipeline

-- 1. Add assigned_pipeline column to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_pipeline VARCHAR(64) DEFAULT 'airtel';
CREATE INDEX IF NOT EXISTS idx_users_assigned_pipeline ON users(assigned_pipeline);

-- 2. Update existing admin@curoai.in to strictly have assigned_pipeline = 'airtel'
UPDATE users
SET assigned_pipeline = 'airtel',
    full_name = 'Airtel Telecom Admin'
WHERE email = 'admin@curoai.in';

-- 3. Insert or update 2nd pipeline Real Estate admin user (estate.admin@curoai.in)
INSERT INTO users (id, email, password_hash, full_name, role, assigned_pipeline, is_active)
VALUES (
    'a2000000-0000-0000-0000-000000000002',
    'estate.admin@curoai.in',
    '$2b$10$tosN1IVn2IeODx4daSM1YeAZaAuJPRa0bu/jgN5SD6rGOuSwyjp/W',
    'My Estate Finder Admin',
    'admin',
    'real_estate',
    true
)
ON CONFLICT (email) DO UPDATE SET
    assigned_pipeline = 'real_estate',
    full_name = 'My Estate Finder Admin',
    role = 'admin',
    is_active = true;

-- Also support alias estate@curoai.in for convenience
INSERT INTO users (id, email, password_hash, full_name, role, assigned_pipeline, is_active)
VALUES (
    'a2000000-0000-0000-0000-000000000003',
    'estate@curoai.in',
    '$2b$10$tosN1IVn2IeODx4daSM1YeAZaAuJPRa0bu/jgN5SD6rGOuSwyjp/W',
    'My Estate Finder Admin',
    'admin',
    'real_estate',
    true
)
ON CONFLICT (email) DO UPDATE SET
    assigned_pipeline = 'real_estate',
    full_name = 'My Estate Finder Admin',
    role = 'admin',
    is_active = true;

-- 4. Add pipeline column to calls table for fast and indexed querying
ALTER TABLE calls ADD COLUMN IF NOT EXISTS pipeline VARCHAR(64) DEFAULT 'airtel';
CREATE INDEX IF NOT EXISTS idx_calls_pipeline ON calls(pipeline);

UPDATE calls
SET pipeline = 'real_estate'
WHERE re_lead_id IS NOT NULL
   OR LOWER(COALESCE(script, '')) LIKE '%estate%'
   OR LOWER(COALESCE(script, '')) LIKE '%sagar%'
   OR LOWER(COALESCE(company_name, '')) LIKE '%estate%'
   OR LOWER(COALESCE(voice_pipeline, '')) LIKE '%aditya%';

UPDATE calls
SET pipeline = 'airtel'
WHERE pipeline IS NULL OR pipeline != 'real_estate';

-- 5. Add pipeline column to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS pipeline VARCHAR(64) DEFAULT 'airtel';
CREATE INDEX IF NOT EXISTS idx_campaigns_pipeline ON campaigns(pipeline);

UPDATE campaigns
SET pipeline = 'real_estate'
WHERE LOWER(name) LIKE '%estate%'
   OR LOWER(name) LIKE '%property%'
   OR LOWER(COALESCE(description, '')) LIKE '%estate%';

UPDATE campaigns
SET pipeline = 'airtel'
WHERE pipeline IS NULL OR pipeline != 'real_estate';

-- 6. Seed a dedicated Real Estate campaign for My Estate Finder
INSERT INTO campaigns (
    id, name, status, pipeline, description, total_contacts, unique_called, successful_calls, failed_calls, remaining_calls, credits_used, total_credits, progress_percent, execution_date
)
VALUES (
    'c2000000-0000-0000-0000-000000000001',
    'My Estate Finder — Delhi NCR Residential Outreach',
    'RUNNING',
    'real_estate',
    'Outbound qualification campaign for residential property owners across Delhi NCR.',
    120, 36, 24, 12, 84, 0, 120, 30, TO_CHAR(NOW(), 'DD Mon YYYY')
)
ON CONFLICT (id) DO NOTHING;
