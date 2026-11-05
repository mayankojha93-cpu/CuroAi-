import { callService } from '../src/services/callService.js';
import { env } from '../src/config/env.js';

async function main() {
  console.log('\n======================================================');
  console.log('   Airtel Voice AI (Priya) - Outbound Test Call CLI   ');
  console.log('======================================================\n');

  const args = process.argv.slice(2);
  let phone = env.TEST_PHONE || '+919811122233';
  let name = 'Rajan Nayak';
  let address = 'Delhi, 110011, burari, sant nagar';
  let accountNo = '20022941256';
  let subsDelNo = '01121344121_wifi';
  let serviceEndDate = '2026-08-27';
  let rDate = '2026-08-29';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phone' && args[i + 1]) phone = args[i + 1];
    if (args[i] === '--name' && args[i + 1]) name = args[i + 1];
    if (args[i] === '--address' && args[i + 1]) address = args[i + 1];
    if (args[i] === '--account' && args[i + 1]) accountNo = args[i + 1];
    if (args[i] === '--subs' && args[i + 1]) subsDelNo = args[i + 1];
    if (args[i] === '--end-date' && args[i + 1]) serviceEndDate = args[i + 1];
    if (args[i] === '--r-date' && args[i + 1]) rDate = args[i + 1];
  }

  console.log('📋 Test Lead Parameters:');
  console.log(`  - Target Phone:      ${phone}`);
  console.log(`  - Customer Name:     ${name}`);
  console.log(`  - Wi-Fi Sub Del No:  ${subsDelNo}`);
  console.log(`  - Account Number:    ${accountNo}`);
  console.log(`  - Service End Date:  ${serviceEndDate}`);
  console.log(`  - R. Date:           ${rDate}`);
  console.log(`  - Address:           ${address}`);
  console.log(`  - Agent Model:       Priya (Sarvam STT + Kimi-k3 / Gemini + Sarvam TTS)`);
  console.log(`  - Outbound SIP Trunk:${env.SIP_OUTBOUND_TRUNK_ID || 'Not Configured'}\n`);

  console.log('⚡ Placing test call with Priya agent dispatch...');

  try {
    const { call, customer } = await callService.initiateTestCall({
      phone,
      name,
      address,
      account_no: accountNo,
      subs_del_no: subsDelNo,
      service_end_date: serviceEndDate,
      r_date: rDate,
      language: 'hi',
    });

    console.log('\n🎉 TEST CALL INITIATED SUCCESSFULLY!');
    console.log(`  - Call ID:           ${call.id}`);
    console.log(`  - Customer ID:       ${customer.id}`);
    console.log(`  - LiveKit Room:      ${call.room_name}`);
    console.log(`  - Call Status:       ${call.status}`);
    console.log('\n👉 LiveKit room and agent dispatch created.');
    console.log('👉 Dispatched to Exotel SIP gateway:', env.SIP_DOMAIN || 'in.voip.exotel.com:5070');
    console.log('👉 Agent Priya will greet the customer upon pickup.');
    console.log('\nMonitoring call and waiting for conversation...');
    let lastStatus = '';
    for (let i = 0; i < 90; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const statusRes = await callService.getCall(call.id);
      if (statusRes.status !== lastStatus) {
        lastStatus = statusRes.status;
        console.log(`\n[Call Status] -> ${statusRes.status.toUpperCase()} | Duration: ${statusRes.duration_seconds || 0}s`);
      } else {
        process.stdout.write('.');
      }

      if (['completed', 'failed', 'no_answer', 'busy', 'cancelled'].includes(statusRes.status)) {
        console.log(`\n\nCall finished. Final Disposition: ${statusRes.final_disposition || 'N/A'}`);

        const rawTranscript = statusRes.transcript;
        const turns = Array.isArray(rawTranscript)
          ? rawTranscript
          : typeof rawTranscript === 'string'
          ? JSON.parse(rawTranscript || '[]')
          : [];

        if (turns.length > 0) {
          console.log('\n======================================================');
          console.log(`  📞 AIRTEL TELECOM CONVERSATION LOG (Call ID: ${call.id})`);
          console.log('------------------------------------------------------');
          for (const t of turns) {
            const isAgent = t.role === 'assistant' || t.role === 'agent';
            console.log(`  ${isAgent ? '🤖 Priya   ' : '🗣️ Customer'}: ${t.text}`);
          }
          console.log('======================================================\n');
        }
        break;
      }
    }

    console.log('\nTest call monitoring complete.\n');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ Failed to initiate test call:');
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
