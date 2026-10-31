-- 016_real_estate_pipeline.sql: Dedicated schema & tables for 2nd Voice Pipeline (My Estate Finder)
-- Completely isolated from existing Airtel Telecom tables

-- 1. Real Estate Leads Table
CREATE TABLE IF NOT EXISTS real_estate_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    owner_name VARCHAR(255),
    phone VARCHAR(32) NOT NULL,
    alternate_phone VARCHAR(32),
    email VARCHAR(255),
    preferred_language VARCHAR(16) DEFAULT 'en',
    lead_status VARCHAR(64) DEFAULT 'NEW',  -- NEW, CONTACTED, QUALIFIED, NOT_INTERESTED, UNREACHABLE
    current_disposition VARCHAR(128),
    total_attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    last_called_at TIMESTAMPTZ,
    next_attempt_time TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_re_leads_phone ON real_estate_leads(phone);
CREATE INDEX IF NOT EXISTS idx_re_leads_status ON real_estate_leads(lead_status);
CREATE INDEX IF NOT EXISTS idx_re_leads_campaign ON real_estate_leads(campaign_id);

-- 2. Link calls table to real_estate_leads without disturbing existing telecom records
ALTER TABLE calls ADD COLUMN IF NOT EXISTS re_lead_id UUID REFERENCES real_estate_leads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_calls_re_lead_id ON calls(re_lead_id);

-- 3. Property Details Captured by the Voice Agent
CREATE TABLE IF NOT EXISTS real_estate_properties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID REFERENCES real_estate_leads(id) ON DELETE CASCADE,
    call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
    
    -- High Level Classification
    category VARCHAR(32) CHECK (category IN ('RESIDENTIAL', 'COMMERCIAL', 'residential', 'commercial')),
    intent VARCHAR(32) CHECK (intent IN ('SALE', 'LEASE', 'RENT', 'sale', 'lease', 'rent')),
    
    -- Location & Identity
    project_or_society VARCHAR(255),
    sector_or_location VARCHAR(255),
    unit_number VARCHAR(64),
    floor_number VARCHAR(64),
    
    -- Configurations
    bhk_config VARCHAR(64),             -- e.g. '2 BHK', '3 BHK', '4 BHK', 'Studio'
    commercial_type VARCHAR(64),        -- e.g. 'Office Space', 'Retail Shop', 'Showroom'
    approx_area_sqft NUMERIC(10, 2),
    furnishing_status VARCHAR(64),      -- 'Unfurnished', 'Semi-furnished', 'Fully furnished'
    
    -- Financials & Availability
    expected_sale_price VARCHAR(128),   -- Stored as string to handle '1.5 Cr', '85 Lakhs', etc.
    expected_monthly_rent VARCHAR(128), -- e.g. '45,000 / month'
    is_currently_leased BOOLEAN DEFAULT FALSE,
    current_rent_received VARCHAR(128),
    immediate_occupancy BOOLEAN DEFAULT TRUE,
    available_from_date DATE,
    
    -- AI Intake Metadata
    raw_notes TEXT,
    confidence_score NUMERIC(3, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_re_prop_lead_id ON real_estate_properties(lead_id);
CREATE INDEX IF NOT EXISTS idx_re_prop_call_id ON real_estate_properties(call_id);
CREATE INDEX IF NOT EXISTS idx_re_prop_category ON real_estate_properties(category);
CREATE INDEX IF NOT EXISTS idx_re_prop_intent ON real_estate_properties(intent);

-- 4. Dedicated Real Estate Call Outcomes Table
CREATE TABLE IF NOT EXISTS real_estate_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id UUID NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES real_estate_leads(id) ON DELETE SET NULL,
    property_id UUID REFERENCES real_estate_properties(id) ON DELETE SET NULL,
    
    final_disposition VARCHAR(128) NOT NULL,
    is_interested BOOLEAN,
    owner_name_confirmed VARCHAR(255),
    transcript JSONB,
    agent_summary TEXT,
    duration_seconds INT,
    median_latency_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_re_outcomes_call_id ON real_estate_outcomes(call_id);
CREATE INDEX IF NOT EXISTS idx_re_outcomes_lead_id ON real_estate_outcomes(lead_id);
CREATE INDEX IF NOT EXISTS idx_re_outcomes_disposition ON real_estate_outcomes(final_disposition);

-- 5. Seed sample Real Estate Leads for instant testing
INSERT INTO real_estate_leads (id, owner_name, phone, preferred_language, lead_status, current_disposition, notes)
VALUES
  ('e1000000-0000-0000-0000-000000000001', 'Vikramaditya Singhania', '+919811122233', 'en', 'NEW', 'Pending Outreach', 'Owner of luxury apartment in Gurgaon Sector 54'),
  ('e1000000-0000-0000-0000-000000000002', 'Ananya Deshmukh', '+919845012345', 'hi', 'NEW', 'Pending Outreach', 'Owner of commercial retail shop in Indiranagar 100ft Road'),
  ('e1000000-0000-0000-0000-000000000003', 'Rajesh Khandelwal', '+919820098765', 'hi', 'NEW', 'Pending Outreach', 'Owner of 3 BHK in Noida Sector 137 looking to rent')
ON CONFLICT (id) DO NOTHING;

