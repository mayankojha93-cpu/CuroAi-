import { SipClient, RoomServiceClient, SipCallError } from 'livekit-server-sdk';
import { env } from '../src/config/env.js';
import { normalizePhone } from '../src/utils/csvParser.js';

async function main() {
  console.log('\n=========================================');
  console.log('   LiveKit Exotel SIP Test Dial Tool     ');
  console.log('=========================================\n');

  // Parse phone from CLI args or env
  const args = process.argv.slice(2);
  let rawPhone = env.TEST_PHONE;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phone' && args[i + 1]) {
      rawPhone = args[i + 1];
    }
  }

  const phone = normalizePhone(rawPhone);

  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    console.error('❌ Missing LiveKit credentials in .env');
    process.exit(1);
  }

  if (!env.SIP_OUTBOUND_TRUNK_ID) {
    console.error('❌ Missing SIP_OUTBOUND_TRUNK_ID in .env');
    console.error('Run: npm run trunk:create first to provision an Exotel outbound trunk!');
    process.exit(1);
  }

  if (!phone || phone === '+919999999999') {
    console.warn(`⚠️ Warning: Dialing configured phone: ${phone}`);
    console.warn('To dial a specific number, run:');
    console.warn('  npm run trunk:dial -- --phone +9198XXXXXXXX\n');
  }

  const roomService = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  const sipClient = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

  const roomName = `test-dial-${Date.now()}`;
  console.log(`📞 Target Callee:      ${phone}`);
  console.log(`🚪 LiveKit Room:       ${roomName}`);
  console.log(`📡 Exotel Trunk:       ${env.SIP_OUTBOUND_TRUNK_ID}`);
  console.log(`🆔 Exotel Caller ID:   ${env.SIP_CALLER_ID || 'Trunk Default'}`);
  console.log('\nInitiating call via Exotel... waiting for callee to answer (30s timeout)...\n');

  try {
    // 1. Ensure room exists
    await roomService.createRoom({
      name: roomName,
      emptyTimeout: 60,
    });

    // 2. Dial the SIP participant (dispatch asynchronously to avoid Twirp HTTP timeout)
    console.log('Sending SIP dispatch request to LiveKit...');
    const participant = await sipClient.createSipParticipant(
      env.SIP_OUTBOUND_TRUNK_ID,
      phone,
      roomName,
      {
        participantIdentity: `phone-${phone.replace(/[^0-9]/g, '')}`,
        displayName: 'Test Customer',
        fromNumber: env.SIP_CALLER_ID || undefined,
        waitUntilAnswered: false,
      }
    );

    console.log('✅ SIP Participant dispatched successfully!');
    console.log(`  - Participant ID:   ${participant.participantId}`);
    console.log(`  - Identity:         ${participant.participantIdentity}`);
    console.log(`  - SIP Call ID:      ${participant.sipCallId}`);
    console.log('\nWaiting for callee to answer the phone (polling room for up to 30s)...\n');

    let answered = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const participants = await roomService.listParticipants(roomName);
      const sipP = participants.find((p) => p.identity === participant.participantIdentity);

      if (sipP) {
        console.log(`[Second ${i + 1}] Participant state in room: ${sipP.state} (kind: ${sipP.kind})`);
        if (sipP.state === 1 /* ACTIVE / JOINED */) {
          console.log('\n🎉 CALL ANSWERED! Phone is active in LiveKit room.');
          answered = true;
          break;
        }
      } else {
        console.log(`[Second ${i + 1}] Waiting for SIP signaling connection...`);
      }
    }

    if (answered) {
      console.log('Keeping room open for 10 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } else {
      console.log('\n⚠️ Call ringing timed out or was rejected by network/callee.');
    }

    console.log('\nCleaning up room...');
    await roomService.deleteRoom(roomName);
    console.log('✅ Room deleted. Telephony test completed.\n');
    process.exit(answered ? 0 : 1);

  } catch (err: any) {
    console.error('\n❌ Call failed or was not answered:\n');
    if (err instanceof SipCallError) {
      console.error(`SIP Status Code: ${err.sipStatusCode} (${err.sipStatus})`);
      console.error(`Message:         ${err.message}`);
      
      if (err.sipStatusCode === 486 || err.sipStatusCode === 600) {
        console.error('👉 The recipient is busy or rejected the call.');
      } else if (err.sipStatusCode === 408 || err.sipStatusCode === 480) {
        console.error('👉 The recipient did not answer within the timeout period.');
      } else if (err.sipStatusCode === 404) {
        console.error('👉 Phone number not found or routing prefix is missing.');
      } else if (err.sipStatusCode === 403) {
        console.error('👉 Authentication/Authorization failed. Check Exotel SIP credentials or IP ACL.');
      }
    } else {
      console.error(err.message || err);
    }

    try {
      await roomService.deleteRoom(roomName);
    } catch (_) {}

    process.exit(1);
  }
}

main();
