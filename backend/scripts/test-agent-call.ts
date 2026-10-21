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
  console.log(`  - Agent Model:       Priya (Sarvam STT + Groq Qwen)`);
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
    console.log('\n👉 If SIP trunk is connected, your phone should ring shortly.');
    console.log('👉 Agent Priya will greet you in Hindi/Hinglish regarding router pickup for account:', accountNo);
    console.log('\nExiting CLI.');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ Failed to initiate test call:');
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
