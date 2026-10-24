-- 007_campaign_calls_seed.sql: Seed realistic call logs and subscriber records for Voice Campaigns

INSERT INTO customers (id, name, phone, address, language, subs_del_no, campaign_id, current_disposition)
VALUES
  ('a1000000-0000-0000-0000-000000000001', 'Subscriber 0318', '+91 64****** 69', 'Indiranagar 12th Main, Bangalore', 'en', 'C1-0318', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000002', 'Subscriber 0317', '+91 80****** 29', 'Koramangala 4th Block, Bangalore', 'hi', 'C1-0317', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000003', 'Subscriber 0316', '+91 93****** 28', 'HSR Layout Sector 2, Bangalore', 'en', 'C1-0316', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000004', 'Subscriber 0315', '+91 63****** 87', 'Whitefield Main Road, Bangalore', 'hi', 'C1-0315', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000005', 'Subscriber 0314', '+91 78****** 25', 'Jayanagar 4th T Block, Bangalore', 'hi', 'C1-0314', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000006', 'Subscriber 0313', '+91 94****** 33', 'Electronic City Phase 1, Bangalore', 'en', 'C1-0313', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000007', 'Subscriber 0312', '+91 94****** 91', 'BTM Layout Stage 2, Bangalore', 'hi', 'C1-0312', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000008', 'Subscriber 0311', '+91 71****** 32', 'Marathahalli Bridge, Bangalore', 'hi', 'C1-0311', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000009', 'Subscriber 0310', '+91 67****** 36', 'Malleshwaram 18th Cross, Bangalore', 'hi', 'C1-0310', 'c1000000-0000-0000-0000-000000000001', 'Goal completed'),
  ('a1000000-0000-0000-0000-000000000010', 'Subscriber 0309', '+91 80****** 07', 'Hebbal Outer Ring Rd, Bangalore', 'en', 'C1-0309', 'c1000000-0000-0000-0000-000000000001', 'Language barrier')
ON CONFLICT (id) DO NOTHING;

-- Seed calls for these customers
INSERT INTO calls (id, customer_id, campaign_id, status, room_name, duration_seconds, created_at, answered_at, ended_at)
VALUES
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0318', 86,  '2026-10-07 16:58:00+05:30', '2026-10-07 16:58:05+05:30', '2026-10-07 16:59:26+05:30'),
  ('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0317', 49,  '2026-10-07 16:56:00+05:30', '2026-10-07 16:56:04+05:30', '2026-10-07 16:56:49+05:30'),
  ('b1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0316', 127, '2026-10-07 16:55:00+05:30', '2026-10-07 16:55:06+05:30', '2026-10-07 16:57:07+05:30'),
  ('b1000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0315', 109, '2026-10-07 16:53:00+05:30', '2026-10-07 16:53:05+05:30', '2026-10-07 16:54:49+05:30'),
  ('b1000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0314', 53,  '2026-10-07 16:52:00+05:30', '2026-10-07 16:52:04+05:30', '2026-10-07 16:52:53+05:30'),
  ('b1000000-0000-0000-0000-000000000006', 'a1000000-0000-0000-0000-000000000006', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0313', 212, '2026-10-07 16:50:00+05:30', '2026-10-07 16:50:08+05:30', '2026-10-07 16:53:32+05:30'),
  ('b1000000-0000-0000-0000-000000000007', 'a1000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0312', 188, '2026-10-07 16:49:00+05:30', '2026-10-07 16:49:07+05:30', '2026-10-07 16:52:08+05:30'),
  ('b1000000-0000-0000-0000-000000000008', 'a1000000-0000-0000-0000-000000000008', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0311', 194, '2026-10-07 16:47:00+05:30', '2026-10-07 16:47:05+05:30', '2026-10-07 16:50:14+05:30'),
  ('b1000000-0000-0000-0000-000000000009', 'a1000000-0000-0000-0000-000000000009', 'c1000000-0000-0000-0000-000000000001', 'completed', 'room_c1_0310', 72,  '2026-10-07 16:46:00+05:30', '2026-10-07 16:46:04+05:30', '2026-10-07 16:47:12+05:30'),
  ('b1000000-0000-0000-0000-000000000010', 'a1000000-0000-0000-0000-000000000010', 'c1000000-0000-0000-0000-000000000001', 'failed',    'room_c1_0309', 14,  '2026-10-07 16:44:00+05:30', '2026-10-07 16:44:03+05:30', '2026-10-07 16:44:14+05:30')
ON CONFLICT (id) DO NOTHING;

-- Seed call_outcomes with results and transcripts
INSERT INTO call_outcomes (call_id, outcome, final_disposition, pickup_accepted, identity_confirmed, transcript)
VALUES
  ('b1000000-0000-0000-0000-000000000001', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Namaste, main Airtel se Priya bol rahi hoon. Kya meri baat subscriber se ho rahi hai?"},{"speaker":"user","text":"Yes, speaking. Tell me."},{"speaker":"agent","text":"Thank you. We are scheduling your router handover for tomorrow."},{"speaker":"user","text":"Sure, please arrange it."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000002', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Namaste! Kya aap kal device pickup ke liye available hain?"},{"speaker":"user","text":"Haan kal afternoon 2 baje theek rahega."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000003', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Hello, calling regarding your Airtel WiFi Router recovery."},{"speaker":"user","text":"Yes, I have packed the device."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000004', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Aapka address Indiranagar confirm hai na sir?"},{"speaker":"user","text":"Haan bilkul wahi aana hai."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000005', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Dhanyawad. Hamare executive kal subah aayenge."},{"speaker":"user","text":"Theek hai dhanyawad."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000006', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Good afternoon! Can we confirm the serial number?"},{"speaker":"user","text":"Yes, I read it out."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000007', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Namaste sir, router pickup ke baare mein baat ho sakti hai?"},{"speaker":"user","text":"Haan ji zaroor."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000008', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Thank you for choosing Airtel fiber."},{"speaker":"user","text":"Welcome."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000009', 'pickup_scheduled', 'Goal completed', true, true, '[{"speaker":"agent","text":"Airtel customer support se Priya. Kya main help kar sakti hoon?"},{"speaker":"user","text":"Yes please schedule for 8th."}]'::jsonb),
  ('b1000000-0000-0000-0000-000000000010', 'pickup_declined',  'Language barrier', false, false, '[{"speaker":"agent","text":"Hello, am I speaking with the account holder?"},{"speaker":"user","text":"Sorry I cannot understand, please speak Tamil."}]'::jsonb)
ON CONFLICT (call_id) DO NOTHING;
