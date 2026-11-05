import { realEstateCallService } from '../src/services/realEstateCallService.js';
import { callService } from '../src/services/callService.js';
import { env } from '../src/config/env.js';

async function main() {
  console.log('\n======================================================');
  console.log('  My Estate Finder (Priya) - Real Estate Test Call    ');
  console.log('======================================================\n');

  const args = process.argv.slice(2);
  let phone = env.TEST_PHONE || '+918658250208';
  let name = env.TEST_CUSTOMER_NAME || 'Raja Nayak';
  let location = 'DLF Phase 5, Sector 54, Gurgaon';
  let language = 'hi';
  let notes = 'Manual CLI test call for Real Estate Pipeline';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phone' && args[i + 1]) phone = args[i + 1];
    if (args[i] === '--name' && args[i + 1]) name = args[i + 1];
    if (args[i] === '--location' && args[i + 1]) location = args[i + 1];
    if (args[i] === '--language' && args[i + 1]) language = args[i + 1];
    if (args[i] === '--notes' && args[i + 1]) notes = args[i + 1];
  }

  console.log('📋 Test Lead Parameters:');
  console.log(`  - Target Phone:       ${phone}`);
  console.log(`  - Property Owner:     ${name}`);
  console.log(`  - Property Location:  ${location}`);
  console.log(`  - Language:           ${language}`);
  console.log(`  - Notes:              ${notes}`);
  console.log(`  - Agent Model:        Priya (${env.REAL_ESTATE_AGENT_NAME || 'my-estate-finder-agent'})`);
  console.log(`  - Voice Pipeline:     Sarvam AI (Priya - bulbul:v3) + Llama 3.3 70B`);
  console.log(`  - Outbound SIP Trunk: ${env.SIP_OUTBOUND_TRUNK_ID || 'Not Configured'}`);
  console.log(`  - Caller ID:          ${env.SIP_CALLER_ID || 'Not Configured'}\n`);

  console.log('⚡ Placing test call with Priya agent dispatch...');

  try {
    const { call, lead } = await realEstateCallService.initiateTestCall({
      phone,
      owner_name: name,
      language,
      property_location: location,
      address: location,
      notes,
    });

    console.log('\n🎉 REAL ESTATE TEST CALL INITIATED SUCCESSFULLY!');
    console.log(`  - Call ID:            ${call.id}`);
    console.log(`  - RE Lead ID:         ${lead.id}`);
    console.log(`  - LiveKit Room:       ${call.room_name}`);
    console.log(`  - Call Status:        ${call.status}`);
    console.log('\n👉 LiveKit room and agent dispatch created.');
    console.log(`👉 Dispatched to Exotel SIP gateway: ${env.SIP_DOMAIN}`);
    console.log('👉 Agent Priya will greet the property owner upon pickup.');
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
          console.log(`  📞 REAL ESTATE CONVERSATION LOG (Call ID: ${call.id})`);
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
    console.error('\n❌ FAILED TO INITIATE REAL ESTATE TEST CALL:');
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
