-- 030_logistics_credentials.sql: Dedicated login credentials for Mittal Pigments Logistics dashboard
-- Ensures logistics.admin@curoai.in has its own unique password hash and strict 'logistics' pipeline access

INSERT INTO users (id, email, password_hash, full_name, role, assigned_pipeline, is_active)
VALUES (
    'a3000000-0000-0000-0000-000000000001',
    'logistics.admin@curoai.in',
    '$2b$10$D9OL2Fcy4AuUCBoCYSBNpOzlpj8DnV1ZRFFQ6CvDByJ3qbnXdt4zu',
    'Mittal Pigments Logistics Ops',
    'admin',
    'logistics',
    true
)
ON CONFLICT (email) DO UPDATE SET
    password_hash = '$2b$10$D9OL2Fcy4AuUCBoCYSBNpOzlpj8DnV1ZRFFQ6CvDByJ3qbnXdt4zu',
    assigned_pipeline = 'logistics',
    full_name = 'Mittal Pigments Logistics Ops',
    role = 'admin',
    is_active = true;
