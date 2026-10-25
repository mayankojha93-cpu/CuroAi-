-- 011_canonical_14_dispositions.sql: Standardizes campaigns, calls, and customer leads to 14 Canonical Dispositions

-- 1. Ensure columns have sufficient length for 14 canonical strings
ALTER TABLE calls 
  ALTER COLUMN call_status TYPE VARCHAR(128);

ALTER TABLE call_outcomes 
  ALTER COLUMN final_disposition TYPE VARCHAR(128);

ALTER TABLE customers 
  ALTER COLUMN current_disposition TYPE VARCHAR(128);

-- 2. Update default expected_dispositions on campaigns table
ALTER TABLE campaigns 
  ALTER COLUMN expected_dispositions SET DEFAULT '[
    "Confirmed For Pickup",
    "Willing To Pickup",
    "Schedule Callback",
    "Already Returned Device",
    "Refused To Return",
    "Willing To Recharge",
    "Already Recharged",
    "Wrong Number",
    "Language Barrier",
    "Do Not Call",
    "Abruptly Disconnected Call",
    "Voicemail or IVR Detected",
    "Not Connected (No Answer)",
    "Not Connected (Failed)"
  ]'::jsonb;

-- 3. Update existing campaigns that have legacy/empty expected dispositions
UPDATE campaigns
SET expected_dispositions = '[
  "Confirmed For Pickup",
  "Willing To Pickup",
  "Schedule Callback",
  "Already Returned Device",
  "Refused To Return",
  "Willing To Recharge",
  "Already Recharged",
  "Wrong Number",
  "Language Barrier",
  "Do Not Call",
  "Abruptly Disconnected Call",
  "Voicemail or IVR Detected",
  "Not Connected (No Answer)",
  "Not Connected (Failed)"
]'::jsonb
WHERE expected_dispositions IS NULL 
   OR jsonb_array_length(expected_dispositions) < 14;

-- 4. Normalize legacy customer dispositions to the 14 Canonical Dispositions
UPDATE customers SET current_disposition = 'Confirmed For Pickup' 
WHERE UPPER(current_disposition) IN ('CONFIRMED', 'PICKUP_CONFIRMED', 'CONFIRMED_PICKUP', 'GOAL COMPLETED', 'PICKUP_SCHEDULED');

UPDATE customers SET current_disposition = 'Willing To Pickup' 
WHERE UPPER(current_disposition) IN ('WILLING_TO_PICKUP', 'WILLING PICKUP', 'WILLING_TO_RETURN');

UPDATE customers SET current_disposition = 'Schedule Callback' 
WHERE UPPER(current_disposition) IN ('SCHEDULE_CALLBACK', 'CALLBACK_REQUESTED', 'CALL_LATER', 'CALLBACK', 'BUSY');

UPDATE customers SET current_disposition = 'Already Returned Device' 
WHERE UPPER(current_disposition) IN ('ALREADY_RETURNED', 'ALREADY_PICKED_UP', 'DEVICE_RETURNED', 'RETURNED');

UPDATE customers SET current_disposition = 'Refused To Return' 
WHERE UPPER(current_disposition) IN ('PICKUP_DECLINED', 'REFUSED', 'DECLINED', 'REFUSED_TO_RETURN', 'DAMAGED_DEVICE', 'LOST_DEVICE');

UPDATE customers SET current_disposition = 'Willing To Recharge' 
WHERE UPPER(current_disposition) IN ('WILLING_TO_RECHARGE', 'WILL_RECHARGE', 'PROMISED_RECHARGE');

UPDATE customers SET current_disposition = 'Already Recharged' 
WHERE UPPER(current_disposition) IN ('RECHARGED_DEVICE', 'ALREADY_RECHARGED', 'ALREADY_USING_DEVICE');

UPDATE customers SET current_disposition = 'Wrong Number' 
WHERE UPPER(current_disposition) IN ('WRONG_NUMBER', 'WRONG_PERSON', 'WRONG_NUMBER_OR_IDENTITY_NOT_CONFIRMED');

UPDATE customers SET current_disposition = 'Language Barrier' 
WHERE UPPER(current_disposition) IN ('LANGUAGE_BARRIER', 'LANGUAGE');

UPDATE customers SET current_disposition = 'Do Not Call' 
WHERE UPPER(current_disposition) IN ('DO_NOT_CALL', 'DND', 'UNSUBSCRIBE');

UPDATE customers SET current_disposition = 'Voicemail or IVR Detected' 
WHERE UPPER(current_disposition) IN ('VOICEMAIL', 'IVR');

UPDATE customers SET current_disposition = 'Not Connected (No Answer)' 
WHERE UPPER(current_disposition) IN ('NO_ANSWER', 'NO_RESPONSE', 'TIMEOUT', 'RINGING_TIMEOUT');

UPDATE customers SET current_disposition = 'Abruptly Disconnected Call' 
WHERE UPPER(current_disposition) IN ('DISCONNECTED', 'ABRUPTLY_DISCONNECTED', 'CALL_DROPPED');

UPDATE customers SET current_disposition = 'Not Connected (Failed)' 
WHERE UPPER(current_disposition) IN ('FAILED', 'NETWORK_FAILURE', 'UNREACHABLE');

-- 5. Normalize call_outcomes table
UPDATE call_outcomes SET final_disposition = 'Confirmed For Pickup' 
WHERE UPPER(final_disposition) IN ('CONFIRMED', 'PICKUP_CONFIRMED', 'CONFIRMED_PICKUP', 'GOAL COMPLETED', 'PICKUP_SCHEDULED');

UPDATE call_outcomes SET final_disposition = 'Willing To Pickup' 
WHERE UPPER(final_disposition) IN ('WILLING_TO_PICKUP', 'WILLING PICKUP', 'WILLING_TO_RETURN');

UPDATE call_outcomes SET final_disposition = 'Schedule Callback' 
WHERE UPPER(final_disposition) IN ('SCHEDULE_CALLBACK', 'CALLBACK_REQUESTED', 'CALL_LATER', 'CALLBACK', 'BUSY');

UPDATE call_outcomes SET final_disposition = 'Already Returned Device' 
WHERE UPPER(final_disposition) IN ('ALREADY_RETURNED', 'ALREADY_PICKED_UP', 'DEVICE_RETURNED', 'RETURNED');

UPDATE call_outcomes SET final_disposition = 'Refused To Return' 
WHERE UPPER(final_disposition) IN ('PICKUP_DECLINED', 'REFUSED', 'DECLINED', 'REFUSED_TO_RETURN', 'DAMAGED_DEVICE', 'LOST_DEVICE');

UPDATE call_outcomes SET final_disposition = 'Willing To Recharge' 
WHERE UPPER(final_disposition) IN ('WILLING_TO_RECHARGE', 'WILL_RECHARGE', 'PROMISED_RECHARGE');

UPDATE call_outcomes SET final_disposition = 'Already Recharged' 
WHERE UPPER(final_disposition) IN ('RECHARGED_DEVICE', 'ALREADY_RECHARGED', 'ALREADY_USING_DEVICE');

UPDATE call_outcomes SET final_disposition = 'Wrong Number' 
WHERE UPPER(final_disposition) IN ('WRONG_NUMBER', 'WRONG_PERSON', 'WRONG_NUMBER_OR_IDENTITY_NOT_CONFIRMED');

UPDATE call_outcomes SET final_disposition = 'Language Barrier' 
WHERE UPPER(final_disposition) IN ('LANGUAGE_BARRIER', 'LANGUAGE');

UPDATE call_outcomes SET final_disposition = 'Do Not Call' 
WHERE UPPER(final_disposition) IN ('DO_NOT_CALL', 'DND', 'UNSUBSCRIBE');

UPDATE call_outcomes SET final_disposition = 'Voicemail or IVR Detected' 
WHERE UPPER(final_disposition) IN ('VOICEMAIL', 'IVR');

UPDATE call_outcomes SET final_disposition = 'Not Connected (No Answer)' 
WHERE UPPER(final_disposition) IN ('NO_ANSWER', 'NO_RESPONSE', 'TIMEOUT', 'RINGING_TIMEOUT');

UPDATE call_outcomes SET final_disposition = 'Abruptly Disconnected Call' 
WHERE UPPER(final_disposition) IN ('DISCONNECTED', 'ABRUPTLY_DISCONNECTED', 'CALL_DROPPED');

UPDATE call_outcomes SET final_disposition = 'Not Connected (Failed)' 
WHERE UPPER(final_disposition) IN ('FAILED', 'NETWORK_FAILURE', 'UNREACHABLE');
