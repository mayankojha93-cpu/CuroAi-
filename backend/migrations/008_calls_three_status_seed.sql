-- 008_calls_three_status_seed.sql: Seed calls supporting SUCCESSFUL, FAILED, and NO ANSWER across all campaigns

INSERT INTO customers (id, name, phone, address, language, subs_del_no, campaign_id, current_disposition)
VALUES
  ('a2000000-0000-0000-0000-000000000001', 'Subscriber 0557', '+91 84****** 16', 'MG Road, Bangalore', 'en', 'C2-0557', 'c1000000-0000-0000-0000-000000000002', 'Language barrier'),
  ('a2000000-0000-0000-0000-000000000002', 'Subscriber 0556', '+91 90****** 72', 'Koramangala 8th Block, Bangalore', 'hi', 'C2-0556', 'c1000000-0000-0000-0000-000000000002', 'Goal completed'),
  ('a2000000-0000-0000-0000-000000000003', 'Subscriber 0555', '+91 99****** 02', 'Indiranagar 100ft Rd, Bangalore', 'hi', 'C2-0555', 'c1000000-0000-0000-0000-000000000002', 'Goal completed'),
  ('a2000000-0000-0000-0000-000000000004', 'Subscriber 0554', '+91 77****** 41', 'Bellandur EcoSpace, Bangalore', 'en', 'C2-0554', 'c1000000-0000-0000-0000-000000000002', 'Goal completed'),
  ('a2000000-0000-0000-0000-000000000005', 'Subscriber 0553', '+91 94****** 47', 'Whitefield ITPL, Bangalore', 'hi', 'C2-0553', 'c1000000-0000-0000-0000-000000000002', 'Call dropped'),
  ('a2000000-0000-0000-0000-000000000006', 'Subscriber 0552', '+91 76****** 95', 'Electronic City Phase 2, Bangalore', 'hi', 'C2-0552', 'c1000000-0000-0000-0000-000000000002', 'Wrong number'),
  ('a2000000-0000-0000-0000-000000000007', 'Subscriber 0551', '+91 91****** 98', 'HSR Layout Sector 1, Bangalore', 'hi', 'C2-0551', 'c1000000-0000-0000-0000-000000000002', 'Goal completed'),
  ('a2000000-0000-0000-0000-000000000008', 'Subscriber 0550', '+91 88****** 62', 'Jayanagar 9th Block, Bangalore', 'hi', 'C2-0550', 'c1000000-0000-0000-0000-000000000002', 'No answer')
ON CONFLICT (id) DO NOTHING;

-- Seed calls with the 3 statuses: completed (Successful), failed (Failed), and no_answer (No Answer)
INSERT INTO calls (id, customer_id, campaign_id, status, room_name, duration_seconds, created_at, answered_at, ended_at)
VALUES
  ('b2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'failed',    'room_c2_0557', 24,  '2026-10-07 16:59:00+05:30', '2026-10-07 16:59:03+05:30', '2026-10-07 16:59:27+05:30'),
  ('b2000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'completed', 'room_c2_0556', 221, '2026-10-07 16:58:00+05:30', '2026-10-07 16:58:05+05:30', '2026-10-07 17:01:46+05:30'),
  ('b2000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000002', 'completed', 'room_c2_0555', 61,  '2026-10-07 16:57:00+05:30', '2026-10-07 16:57:04+05:30', '2026-10-07 16:58:05+05:30'),
  ('b2000000-0000-0000-0000-000000000004', 'a2000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000002', 'completed', 'room_c2_0554', 175, '2026-10-07 16:56:00+05:30', '2026-10-07 16:56:06+05:30', '2026-10-07 16:59:01+05:30'),
  ('b2000000-0000-0000-0000-000000000005', 'a2000000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000002', 'failed',    'room_c2_0553', 6,   '2026-10-07 16:55:00+05:30', '2026-10-07 16:55:02+05:30', '2026-10-07 16:55:08+05:30'),
  ('b2000000-0000-0000-0000-000000000006', 'a2000000-0000-0000-0000-000000000006', 'c1000000-0000-0000-0000-000000000002', 'failed',    'room_c2_0552', 8,   '2026-10-07 16:54:00+05:30', '2026-10-07 16:54:03+05:30', '2026-10-07 16:54:11+05:30'),
  ('b2000000-0000-0000-0000-000000000007', 'a2000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000002', 'completed', 'room_c2_0551', 163, '2026-10-07 16:53:00+05:30', '2026-10-07 16:53:05+05:30', '2026-10-07 16:55:48+05:30'),
  ('b2000000-0000-0000-0000-000000000008', 'a2000000-0000-0000-0000-000000000008', 'c1000000-0000-0000-0000-000000000002', 'no_answer', 'room_c2_0550', 0,   '2026-10-07 16:52:00+05:30', NULL,                        '2026-10-07 16:52:45+05:30')
ON CONFLICT (id) DO NOTHING;

-- Seed call_outcomes with final_disposition for all 3 statuses
INSERT INTO call_outcomes (call_id, outcome, final_disposition, pickup_accepted, identity_confirmed, transcript)
VALUES
  ('b2000000-0000-0000-0000-000000000001', 'pickup_declined',  'Language barrier', false, false, '[{"speaker":"agent","text":"Namaste! Am I speaking with the subscriber?"},{"speaker":"user","text":"Sorry no speak Hindi, English please."}]'::jsonb),
  ('b2000000-0000-0000-0000-000000000002', 'pickup_scheduled', 'Goal completed',   true,  true,  '[{"speaker":"agent","text":"Namaste sir, aapka WiFi router pickup arrange karna hai."},{"speaker":"user","text":"Haan kal subah 11 baje bhej dijiye."}]'::jsonb),
  ('b2000000-0000-0000-0000-000000000003', 'pickup_scheduled', 'Goal completed',   true,  true,  '[{"speaker":"agent","text":"Airtel service se Priya. Router recovery ke liye call kiya hai."},{"speaker":"user","text":"Haan ready hai device."}]'::jsonb),
  ('b2000000-0000-0000-0000-000000000004', 'pickup_scheduled', 'Goal completed',   true,  true,  '[{"speaker":"agent","text":"Good afternoon, scheduling pickup for your Airtel router."},{"speaker":"user","text":"Yes, I will be home after 4 PM."}]'::jsonb),
  ('b2000000-0000-0000-0000-000000000005', 'no_response',      'Call dropped',     false, false, '[{"speaker":"agent","text":"Hello, am I speaking with the account holder?"}]'::jsonb),
  ('b2000000-0000-0000-0000-000000000006', 'wrong_person',     'Wrong number',     false, false, '[{"speaker":"agent","text":"Namaste, kya meri baat Airtel subscriber se ho rahi hai?"},{"speaker":"user","text":"Wrong number hai bhai."}]'::jsonb),
  ('b2000000-0000-0000-0000-000000000007', 'pickup_scheduled', 'Goal completed',   true,  true,  '[{"speaker":"agent","text":"Namaste! Router pickup confirm ho gaya hai."},{"speaker":"user","text":"Shukriya."}]'::jsonb),
  ('b2000000-0000-0000-0000-000000000008', 'no_response',      'No answer',        false, false, '[]'::jsonb)
ON CONFLICT (call_id) DO NOTHING;
