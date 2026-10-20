-- 001_init.sql: Create tables for customers, calls, and call_outcomes

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(32) NOT NULL UNIQUE,
    address TEXT NOT NULL,
    language VARCHAR(16) NOT NULL DEFAULT 'hi',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL CHECK (
        status IN ('initiated', 'dialing', 'answered', 'completed', 'no_answer', 'busy', 'failed')
    ),
    room_name VARCHAR(128) NOT NULL UNIQUE,
    sip_call_id VARCHAR(128),
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS call_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id UUID NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
    outcome VARCHAR(32) NOT NULL CHECK (
        outcome IN ('pickup_scheduled', 'pickup_declined', 'wrong_person', 'callback_requested', 'escalated', 'no_response')
    ),
    pickup_date DATE,
    address_confirmed BOOLEAN,
    corrected_address TEXT,
    transcript JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Helpful indices for fast querying and status updates
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_calls_room_name ON calls(room_name);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_outcomes_call_id ON call_outcomes(call_id);
