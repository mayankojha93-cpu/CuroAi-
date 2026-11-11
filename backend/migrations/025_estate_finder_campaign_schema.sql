-- 025_estate_finder_campaign_schema.sql
-- Completes schema alignment for 2nd Pipeline (Estate Finder) campaigns:
-- Target Audience 4-column storage (Customer Name, Mobile, Email, Address -> property_location)
-- and high-performance query indexes for campaign leads, calls, and reporting.

-- 1. Ensure property_location and email columns on real_estate_leads
ALTER TABLE real_estate_leads 
  ADD COLUMN IF NOT EXISTS property_location VARCHAR(255);

ALTER TABLE real_estate_leads 
  ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- 2. Ensure property_location column on calls
ALTER TABLE calls 
  ADD COLUMN IF NOT EXISTS property_location VARCHAR(255);

-- 3. High performance indexes for Estate Finder campaign operations
CREATE INDEX IF NOT EXISTS idx_re_leads_phone ON real_estate_leads(phone);
CREATE INDEX IF NOT EXISTS idx_re_leads_campaign ON real_estate_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_re_leads_email ON real_estate_leads(email);
CREATE INDEX IF NOT EXISTS idx_re_leads_location ON real_estate_leads(property_location);
CREATE INDEX IF NOT EXISTS idx_campaigns_pipeline ON campaigns(pipeline);
CREATE INDEX IF NOT EXISTS idx_calls_campaign_re_lead ON calls(campaign_id, re_lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_pipeline ON calls(pipeline);
CREATE INDEX IF NOT EXISTS idx_calls_re_lead_id ON calls(re_lead_id);

-- 4. Seed / upsert sample leads with complete 4-column data for immediate testing
INSERT INTO real_estate_leads (id, campaign_id, owner_name, phone, email, property_location, preferred_language, lead_status, current_disposition, notes)
VALUES
  ('e1000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'Vikramaditya Singhania', '+919811122233', 'vikram@example.com', 'DLF The Camellias, Golf Course Road, Gurgaon Sector 42', 'en', 'NEW', 'Pending Outreach', 'Owner of luxury apartment in Gurgaon Sector 42'),
  ('e1000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'Ananya Deshmukh', '+919845012345', 'ananya@example.com', '100ft Road, Indiranagar, Bengaluru', 'hi', 'NEW', 'Pending Outreach', 'Owner of commercial retail shop in Indiranagar 100ft Road'),
  ('e1000000-0000-0000-0000-000000000003', 'c2000000-0000-0000-0000-000000000001', 'Rajesh Khandelwal', '+919820098765', 'rajesh@example.com', 'Tower 4, Purvanchal Royal City, Greater Noida', 'hi', 'NEW', 'Pending Outreach', 'Owner of 3 BHK in Greater Noida looking to rent')
ON CONFLICT (id) DO UPDATE SET
  owner_name = EXCLUDED.owner_name,
  phone = EXCLUDED.phone,
  email = EXCLUDED.email,
  property_location = EXCLUDED.property_location,
  campaign_id = COALESCE(real_estate_leads.campaign_id, EXCLUDED.campaign_id);
