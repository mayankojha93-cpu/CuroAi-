import { realEstateCallService } from '../src/services/realEstateCallService.js';
import { callService } from '../src/services/callService.js';
import { env } from '../src/config/env.js';

async function main() {
  console.log('\n======================================================');
  console.log('  My Estate Finder (Sagar) - Real Estate Test Call    ');
  console.log('======================================================\n');

  const args = process.argv.slice(2);
  let phone = env.TEST_PHONE || '+918658250208';
  let name = env.TEST_CUSTOMER_NAME || 'Raja Nayak';
  let language = 'en';
  let notes = 'Manual CLI test call for Real Estate Pipeline';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phone' && args[i + 1]) phone = args[i + 1];
    if (args[i] === '--name' && args[i + 1]) name = args[i + 1];
    if (args[i] === '--language' && args[i + 1]) language = args[i + 1];
    if (args[i] === '--notes' && args[i + 1]) notes = args[i + 1];
  }

  console.log('📋 Test Lead Parameters:');
  console.log(`  - Target Phone:       ${phone}`);
  console.log(`  - Property Owner:     ${name}`);
  console.log(`  - Language:           ${language}`);
  console.log(`  - Notes:              ${notes}`);
  console.log(`  - Agent Model:        Sagar (${env.REAL_ESTATE_AGENT_NAME || 'my-estate-finder-agent'})`);
  console.log(`  - Voice Pipeline:     Sarvam AI (Aditya - hi-IN) + Llama 3.3 70B`);
  console.log(`  - Outbound SIP Trunk: ${env.SIP_OUTBOUND_TRUNK_ID || 'Not Configured'}`);
  console.log(`  - Caller ID:          ${env.SIP_CALLER_ID || 'Not Configured'}\n`);

  console.log('⚡ Placing test call with Sagar agent dispatch...');

  try {
    const { call, lead } = await realEstateCallService.initiateTestCall({
      phone,
      owner_name: name,
      language,
      notes,
    });

    console.log('\n🎉 REAL ESTATE TEST CALL INITIATED SUCCESSFULLY!');
    console.log(`  - Call ID:            ${call.id}`);
    console.log(`  - RE Lead ID:         ${lead.id}`);
    console.log(`  - LiveKit Room:       ${call.room_name}`);
    console.log(`  - Call Status:        ${call.status}`);
    console.log('\n👉 LiveKit room and agent dispatch created.');
    console.log(`👉 Dispatched to Exotel SIP gateway: ${env.SIP_DOMAIN}`);
    console.log('👉 Agent Sagar will greet the property owner upon pickup.');
    console.log('\nMonitoring call status for 25 seconds...');
    for (let i = 0; i < 25; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const statusRes = await callService.getCall(call.id);
      process.stdout.write(`\r[Second ${i + 1}] Status: ${statusRes.status} | SIP ID: ${statusRes.sip_call_id || 'connecting...'}`);
      if (statusRes.status === 'answered' || statusRes.status === 'in_progress' || statusRes.status === 'completed') {
        console.log('\n\n🎉 Call active/answered with AI Agent Sagar!');
        break;
      }
      if (statusRes.status === 'failed') {
        console.log(`\n\n❌ Call failed: ${statusRes.failure_reason || 'Unknown reason'}`);
        break;
      }
    }

    console.log('\n\nTest call monitoring complete.\n');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ FAILED TO INITIATE REAL ESTATE TEST CALL:');
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
