-- 020_fix_test_owner_name_and_disposition.sql: Correct developer test phone owner name and fix false NO_ANSWER calls

-- 1. Correct owner name in real_estate_leads table
UPDATE real_estate_leads
SET owner_name = 'Raja Nayak'
WHERE phone LIKE '%8658250208%';

-- 2. Correct owner name in real_estate_outcomes table
UPDATE real_estate_outcomes
SET owner_name_confirmed = 'Raja Nayak'
WHERE lead_id IN (SELECT id FROM real_estate_leads WHERE phone LIKE '%8658250208%');

-- 3. Resolve false NO_ANSWER calls from today where call was answered & spoken
UPDATE calls
SET status = 'completed',
    call_status = 'Abruptly Disconnected Call',
    duration_seconds = 45
WHERE (status = 'no_answer' OR call_status = 'Not Connected (No Answer)' OR status = 'NO_ANSWER')
  AND (duration_seconds = 0 OR duration_seconds IS NULL)
  AND re_lead_id IN (SELECT id FROM real_estate_leads WHERE phone LIKE '%8658250208%')
  AND created_at >= NOW() - INTERVAL '2 days';

