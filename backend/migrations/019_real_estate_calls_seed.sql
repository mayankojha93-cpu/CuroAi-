-- 019_real_estate_calls_seed.sql: Seed realistic sample calls for My Estate Finder (2nd Pipeline)
-- Ensures fresh VPS deployments display call logs and test call history from day one

-- Ensure sample real estate leads exist
INSERT INTO real_estate_leads (id, owner_name, phone, preferred_language, lead_status, current_disposition, notes)
VALUES
  ('e1000000-0000-0000-0000-000000000001', 'Vikramaditya Singhania', '+919811122233', 'en', 'QUALIFIED', 'Qualified Lead', 'Owner of luxury apartment in Gurgaon Sector 54'),
  ('e1000000-0000-0000-0000-000000000002', 'Ananya Deshmukh', '+919845012345', 'en', 'NOT_INTERESTED', 'Not Interested', 'Owner of commercial retail shop in Indiranagar'),
  ('e1000000-0000-0000-0000-000000000003', 'Rajesh Khandelwal', '+919820098765', 'en', 'CALLBACK', 'Schedule Callback', 'Owner of 3 BHK in Noida Sector 137 looking to rent'),
  ('fb9f92a0-c340-4280-b507-126179085a98', 'Mayank Ojha', '+917412034540', 'en', 'QUALIFIED', 'Qualified Lead', 'Owner of commercial unit in JMD Megapolis')
ON CONFLICT (id) DO UPDATE SET
  owner_name = EXCLUDED.owner_name,
  phone = EXCLUDED.phone;

-- Ensure dedicated Real Estate campaign exists
INSERT INTO campaigns (
    id, name, status, pipeline, description, total_contacts, unique_called, successful_calls, failed_calls, remaining_calls, credits_used, total_credits, progress_percent, execution_date
)
VALUES (
    'c2000000-0000-0000-0000-000000000001',
    'My Estate Finder',
    'RUNNING',
    'real_estate',
    'Outbound qualification campaign for property owners across Delhi NCR.',
    120, 36, 24, 12, 84, 0, 120, 30, TO_CHAR(NOW(), 'DD Mon YYYY')
)
ON CONFLICT (id) DO UPDATE SET
  name = 'My Estate Finder',
  pipeline = 'real_estate';

-- Seed sample calls for Real Estate pipeline
INSERT INTO calls (id, re_lead_id, campaign_id, pipeline, script, company_name, voice_pipeline, status, call_status, duration_seconds, is_test_call, created_at, answered_at, ended_at)
VALUES
  (
    'c45dbb98-d114-4915-a057-60953ebe6a54',
    'fb9f92a0-c340-4280-b507-126179085a98',
    'c2000000-0000-0000-0000-000000000001',
    'real_estate',
    'My Estate Finder — Property Intake (Sagar)',
    'My Estate Finder',
    'Sarvam AI (Aditya - hi-IN)',
    'completed',
    'Abruptly Disconnected Call',
    175,
    TRUE,
    NOW() - INTERVAL '4 hours',
    NOW() - INTERVAL '4 hours' + INTERVAL '5 seconds',
    NOW() - INTERVAL '4 hours' + INTERVAL '180 seconds'
  ),
  (
    'c45dbb98-d114-4915-a057-60953ebe6a55',
    'e1000000-0000-0000-0000-000000000001',
    'c2000000-0000-0000-0000-000000000001',
    'real_estate',
    'My Estate Finder — Property Intake (Sagar)',
    'My Estate Finder',
    'Sarvam AI (Aditya - hi-IN)',
    'completed',
    'Qualified Lead',
    131,
    TRUE,
    NOW() - INTERVAL '5 hours',
    NOW() - INTERVAL '5 hours' + INTERVAL '5 seconds',
    NOW() - INTERVAL '5 hours' + INTERVAL '136 seconds'
  ),
  (
    'c45dbb98-d114-4915-a057-60953ebe6a56',
    'e1000000-0000-0000-0000-000000000003',
    'c2000000-0000-0000-0000-000000000001',
    'real_estate',
    'My Estate Finder — Property Intake (Sagar)',
    'My Estate Finder',
    'Sarvam AI (Aditya - hi-IN)',
    'completed',
    'Schedule Callback',
    123,
    TRUE,
    NOW() - INTERVAL '1 day',
    NOW() - INTERVAL '1 day' + INTERVAL '5 seconds',
    NOW() - INTERVAL '1 day' + INTERVAL '128 seconds'
  ),
  (
    'c45dbb98-d114-4915-a057-60953ebe6a57',
    'e1000000-0000-0000-0000-000000000002',
    'c2000000-0000-0000-0000-000000000001',
    'real_estate',
    'My Estate Finder — Property Intake (Sagar)',
    'My Estate Finder',
    'Sarvam AI (Aditya - hi-IN)',
    'completed',
    'Not Interested',
    38,
    TRUE,
    NOW() - INTERVAL '1 day' - INTERVAL '2 hours',
    NOW() - INTERVAL '1 day' - INTERVAL '2 hours' + INTERVAL '5 seconds',
    NOW() - INTERVAL '1 day' - INTERVAL '2 hours' + INTERVAL '43 seconds'
  )
ON CONFLICT (id) DO NOTHING;

-- Seed property dossiers
INSERT INTO real_estate_properties (
  id, lead_id, call_id, category, intent, project_or_society, sector_or_location,
  unit_number, floor_number, bhk_config, commercial_type, approx_area_sqft, expected_sale_price
)
VALUES
  (
    '0b9c80ff-29ab-407c-8aab-efd14cbb4b1b',
    'fb9f92a0-c340-4280-b507-126179085a98',
    'c45dbb98-d114-4915-a057-60953ebe6a54',
    'commercial',
    'sale',
    'Estate Green, JMD Megapolis',
    'Sector 81',
    '292',
    '4',
    NULL,
    'Commercial Office/Shop',
    1250,
    '1.85 Cr'
  ),
  (
    '923d300f-9911-42a1-8fd9-954ef9b5b00f',
    'e1000000-0000-0000-0000-000000000001',
    'c45dbb98-d114-4915-a057-60953ebe6a55',
    'residential',
    'sale',
    'DLF The Camellias',
    'Sector 42, Golf Course Road, Gurgaon',
    '1202',
    '12',
    '4 BHK',
    NULL,
    7400,
    '18.5 Cr'
  )
ON CONFLICT (id) DO NOTHING;

-- Seed real estate outcomes with transcripts
INSERT INTO real_estate_outcomes (
  call_id, lead_id, property_id, final_disposition, is_interested, owner_name_confirmed,
  transcript, agent_summary, duration_seconds
)
VALUES
  (
    'c45dbb98-d114-4915-a057-60953ebe6a54',
    'fb9f92a0-c340-4280-b507-126179085a98',
    '0b9c80ff-29ab-407c-8aab-efd14cbb4b1b',
    'Abruptly Disconnected Call',
    TRUE,
    'Mayank Ojha',
    '[{"role":"assistant","text":"Hello Mayank ji, main Sagar bol raha hoon My Estate Finder se."},{"role":"user","text":"Haan boliye."},{"role":"assistant","text":"Aapki property intake ke liye call kiya tha. Kaunsi society mein property hai?"},{"role":"user","text":"Estate Green, JMD Megapolis Sector 81. Unit number 292 on 4th floor."},{"role":"assistant","text":"Bahut badhiya! Commercial unit hai ya residential?"},{"role":"user","text":"Commercial shop hai, sell karni hai."}]'::jsonb,
    'Owner confirmed commercial unit 292 on 4th floor in Estate Green, JMD Megapolis Sector 81 for sale.',
    175
  ),
  (
    'c45dbb98-d114-4915-a057-60953ebe6a55',
    'e1000000-0000-0000-0000-000000000001',
    '923d300f-9911-42a1-8fd9-954ef9b5b00f',
    'Qualified Lead',
    TRUE,
    'Vikramaditya Singhania',
    '[{"role":"assistant","text":"Hello Vikramaditya ji, Sagar speaking from My Estate Finder."},{"role":"user","text":"Yes, tell me."},{"role":"assistant","text":"Calling regarding your listing at DLF The Camellias."},{"role":"user","text":"Yes, looking to sell 4 BHK unit 1202 on 12th floor. Expected 18.5 Cr."}]'::jsonb,
    'Qualified luxury apartment sale in DLF The Camellias.',
    131
  ),
  (
    'c45dbb98-d114-4915-a057-60953ebe6a56',
    'e1000000-0000-0000-0000-000000000003',
    NULL,
    'Schedule Callback',
    TRUE,
    'Rajesh Khandelwal',
    '[{"role":"assistant","text":"Namaste Rajesh ji, Sagar from My Estate Finder."},{"role":"user","text":"Main thoda busy hoon, kal call kijiye 2 baje."}]'::jsonb,
    'Customer requested callback tomorrow at 2 PM.',
    123
  ),
  (
    'c45dbb98-d114-4915-a057-60953ebe6a57',
    'e1000000-0000-0000-0000-000000000002',
    NULL,
    'Not Interested',
    FALSE,
    'Ananya Deshmukh',
    '[{"role":"assistant","text":"Hello Ananya ji, Sagar from My Estate Finder."},{"role":"user","text":"Nahi bechni abhi, plans change ho gaye."}]'::jsonb,
    'Owner not interested in selling at this moment.',
    38
  )
ON CONFLICT (call_id) DO NOTHING;
