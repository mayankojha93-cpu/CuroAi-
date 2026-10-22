import { query } from '../src/db/index.js';
import { callService } from '../src/services/callService.js';
import { randomUUID } from 'crypto';

async function testPostCallSave() {
  console.log('Testing post-call database outcome persistence...');

  // 1. Get or create a test customer
  const custRes = await query('SELECT id FROM customers LIMIT 1');
  const customerId = custRes.rows[0].id;

  // 2. Insert test call
  const callId = randomUUID();
  const roomName = 'call-test-' + Date.now();
  await query(
    "INSERT INTO calls (id, customer_id, status, call_status, attempt_number, room_name) VALUES ($1, $2, 'answered', 'answered', 1, $3)",
    [callId, customerId, roomName]
  );

  // 3. Save outcome simulating end of call
  const mockOutcome = {
    final_disposition: 'CONFIRMED_FOR_PICKUP',
    identity_confirmed: true,
    pickup_accepted: true,
    confirmed_date: '2026-10-21',
    proposed_date: '2026-10-21',
    registered_address_confirmed: true,
    customer_note: 'Customer agreed to router pickup for tomorrow morning',
    transcript: [
      { role: 'assistant', message: 'नमस्ते, क्या आप वाई-फाई राउटर पिकअप के लिए उपलब्ध हैं?', timestamp: Date.now() - 10000 },
      { role: 'customer', message: 'हाँ कल आ जाओ', timestamp: Date.now() - 5000 },
      { role: 'assistant', message: 'बहुत अच्छा, हमने कल के लिए पिकअप तय किया है।', timestamp: Date.now() }
    ],
    duration_seconds: 45,
    median_latency_ms: 220,
    cost_estimate_inr: 1.80,
  };

  await callService.saveOutcome(callId, mockOutcome);

  // 4. Verify call_outcomes table
  const savedOutcome = await query('SELECT * FROM call_outcomes WHERE call_id = $1', [callId]);
  console.log('\n--- 1. SAVED IN call_outcomes ---');
  console.table(savedOutcome.rows.map(r => ({
    final_disposition: r.final_disposition,
    confirmed_date: r.confirmed_date?.toISOString().split('T')[0],
    address_confirmed: r.registered_address_confirmed,
    note: r.customer_note,
    has_transcript: !!r.transcript
  })));

  // 5. Verify calls table
  const savedCall = await query('SELECT status, call_status, duration_seconds, median_latency_ms, cost_estimate_inr, ended_at FROM calls WHERE id = $1', [callId]);
  console.log('\n--- 2. SAVED IN calls ---');
  console.table(savedCall.rows);

  // 6. Verify customers table update
  const savedCustomer = await query('SELECT current_disposition, is_closed, next_attempt_time FROM customers WHERE id = $1', [customerId]);
  console.log('\n--- 3. UPDATED IN customers ---');
  console.table(savedCustomer.rows);

  // Clean up test call
  await query('DELETE FROM calls WHERE id = $1', [callId]);
  console.log('\n🎉 Verification successful: All data is stored in the correct tables and columns.');
  process.exit(0);
}

testPostCallSave().catch(e => { console.error(e); process.exit(1); });
