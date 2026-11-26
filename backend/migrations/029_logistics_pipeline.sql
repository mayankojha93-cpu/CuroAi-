-- 029_logistics_pipeline.sql: Dedicated schema & tables for 3rd Voice Pipeline (Mittal Pigments Logistics Assistant)
-- Completely isolated from existing Airtel Telecom and Real Estate tables

-- 1. Logistics Trips Table
CREATE TABLE IF NOT EXISTS logistics_trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_name VARCHAR(255) NOT NULL,
    driver_phone VARCHAR(32) NOT NULL,
    vehicle_number VARCHAR(64) NOT NULL,
    lr_number VARCHAR(128) NOT NULL,
    origin VARCHAR(255),
    destination VARCHAR(255),
    consignee VARCHAR(255),
    material VARCHAR(255) DEFAULT 'Pigment powder bags / drums',
    expected_unload_date VARCHAR(64),
    current_call_round INT NOT NULL DEFAULT 1, -- 1 = morning, 2 = evening
    next_assignment TEXT,
    plant_contact_number VARCHAR(32),
    ops_number VARCHAR(32) NOT NULL DEFAULT '9800000000',
    trip_status VARCHAR(64) NOT NULL DEFAULT 'PENDING', -- PENDING, IN_TRANSIT, WAITING_UNLOAD, UNLOADED, ESCALATED, CALLBACK_SCHEDULED, NO_RESPONSE, CLOSED
    last_called_at TIMESTAMPTZ,
    next_callback_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logistics_trips_phone ON logistics_trips(driver_phone);
CREATE INDEX IF NOT EXISTS idx_logistics_trips_vehicle ON logistics_trips(vehicle_number);
CREATE INDEX IF NOT EXISTS idx_logistics_trips_status ON logistics_trips(trip_status);

-- 2. Link calls table to logistics_trips without disturbing existing telecom/real-estate records
ALTER TABLE calls ADD COLUMN IF NOT EXISTS logistics_trip_id UUID REFERENCES logistics_trips(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_calls_logistics_trip_id ON calls(logistics_trip_id);

-- 3. Dedicated Logistics Call Outcomes Table (mirrors exact End-of-Call JSON schema)
CREATE TABLE IF NOT EXISTS logistics_call_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id UUID NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
    trip_id UUID REFERENCES logistics_trips(id) ON DELETE SET NULL,

    call_status VARCHAR(64) NOT NULL DEFAULT 'connected', -- connected | no_answer | busy_callback | wrong_person
    callback_time VARCHAR(128),
    vehicle_number VARCHAR(64),
    lr_number VARCHAR(128),
    unloaded VARCHAR(32) DEFAULT 'unknown', -- yes | no | on_the_way | unknown
    current_location VARCHAR(255),
    unloading_delay_reason VARCHAR(64) DEFAULT 'none', -- queue | party_closed | weighbridge | documents | shortage_damage | union_charges | breakdown | other | none
    waiting_hours VARCHAR(64),
    pod_signed_received VARCHAR(16) DEFAULT 'na', -- yes | no | na
    shortage_or_damage_reported VARCHAR(16) DEFAULT 'no', -- yes | no
    issue_details TEXT,
    money_demanded_amount VARCHAR(64),
    next_assignment_communicated VARCHAR(16) DEFAULT 'no', -- yes | no
    driver_accepted_next_assignment VARCHAR(32) DEFAULT 'no', -- yes | no | needs_discussion
    driver_departure_eta VARCHAR(128),
    priority VARCHAR(32) NOT NULL DEFAULT 'normal', -- normal | high | urgent
    escalate_to_human VARCHAR(16) NOT NULL DEFAULT 'no', -- yes | no
    driver_questions_for_ops TEXT,
    summary_in_english TEXT,

    raw_json JSONB,
    transcript JSONB,
    duration_seconds INT,
    median_latency_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logistics_outcomes_call_id ON logistics_call_outcomes(call_id);
CREATE INDEX IF NOT EXISTS idx_logistics_outcomes_trip_id ON logistics_call_outcomes(trip_id);
CREATE INDEX IF NOT EXISTS idx_logistics_outcomes_priority ON logistics_call_outcomes(priority);
CREATE INDEX IF NOT EXISTS idx_logistics_outcomes_escalate ON logistics_call_outcomes(escalate_to_human);

-- 4. Dedicated Logistics Ops Admin User
INSERT INTO users (id, email, password_hash, full_name, role, assigned_pipeline, is_active)
VALUES (
    'a3000000-0000-0000-0000-000000000001',
    'logistics.admin@curoai.in',
    '$2b$10$tosN1IVn2IeODx4daSM1YeAZaAuJPRa0bu/jgN5SD6rGOuSwyjp/W',
    'Mittal Pigments Logistics Ops',
    'admin',
    'logistics',
    true
)
ON CONFLICT (email) DO UPDATE SET
    assigned_pipeline = 'logistics',
    full_name = 'Mittal Pigments Logistics Ops',
    role = 'admin',
    is_active = true;

-- 5. Seed sample trips for instant testing
INSERT INTO logistics_trips (
    id, driver_name, driver_phone, vehicle_number, lr_number, origin, destination, consignee,
    material, expected_unload_date, current_call_round, next_assignment, plant_contact_number, ops_number, trip_status
)
VALUES
(
    'd1000000-0000-0000-0000-000000000001',
    'Ramesh',
    '+919811122233',
    'RJ14GA4521',
    'LR-88421',
    'Kota Plant',
    'Ahmedabad',
    'Shreeji Chemicals Ahmedabad',
    'Pigment powder bags',
    '2026-11-26',
    1,
    'Jammu ke manufacturing plant (Mittal Pigments, Bari Brahmana industrial area) se agla maal uthana hai. Plant contact: Sharma ji, 9811100022. Kal subah 10 baje tak pahunchna hai.',
    '9811100022',
    '9800011122',
    'PENDING'
),
(
    'd1000000-0000-0000-0000-000000000002',
    'Suresh Yadav',
    '+919822233344',
    'HR55AB9012',
    'LR-88455',
    'Bari Brahmana Jammu',
    'Bhiwadi',
    'Apex Paints Bhiwadi',
    'Pigment drums',
    '2026-11-26',
    2,
    'Bhiwadi depot par khali karne ke baad Kota plant ke liye return load lena hai. Ops team se confirm kar lena.',
    '9811100033',
    '9800011122',
    'WAITING_UNLOAD'
)
ON CONFLICT (id) DO NOTHING;
