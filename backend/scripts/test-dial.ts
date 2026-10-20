import { SipClient, RoomServiceClient, SipCallError } from 'livekit-server-sdk';
import { env } from '../src/config/env.js';

async function main() {
  console.log('\n=========================================');
  console.log('   LiveKit Telephony Test Dial Script    ');
  console.log('=========================================\n');

  // Parse phone from CLI args or env
  const args = process.argv.slice(2);
  let phone = env.TEST_PHONE;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phone' && args[i + 1]) {
      phone = args[i + 1];
    }
  }

  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    console.error('❌ Missing LiveKit credentials in .env');
    process.exit(1);
  }

  if (!env.SIP_OUTBOUND_TRUNK_ID) {
    console.error('❌ Missing SIP_OUTBOUND_TRUNK_ID in .env');
    console.error('Run: npm run trunk:create first to provision an outbound trunk!');
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
  console.log(`📞 Target Phone:       ${phone}`);
  console.log(`🚪 LiveKit Room:       ${roomName}`);
  console.log(`📡 Outbound Trunk:     ${env.SIP_OUTBOUND_TRUNK_ID}`);
  console.log(`🆔 Caller ID / From:   ${env.SIP_CALLER_ID || 'Trunk Default'}`);
  console.log('\nInitiating call... waiting for callee to answer (30s timeout)...\n');

  try {
    // 1. Ensure room exists
    await roomService.createRoom({
      name: roomName,
      emptyTimeout: 60,
    });

    // 2. Dial the SIP participant
    const participant = await sipClient.createSipParticipant(
      env.SIP_OUTBOUND_TRUNK_ID,
      phone,
      roomName,
      {
        participantIdentity: `phone-${phone.replace(/[^0-9]/g, '')}`,
        displayName: 'Test Customer',
        fromNumber: env.SIP_CALLER_ID || undefined,
        waitUntilAnswered: true,
        ringingTimeout: 30,
      }
    );

    console.log('🎉 CALL ANSWERED! Phone is connected to LiveKit room.');
    console.log('Participant Details:');
    console.log(`  - Participant ID:   ${participant.participantId}`);
    console.log(`  - Identity:         ${participant.participantIdentity}`);
    console.log(`  - SIP Call ID:      ${participant.sipCallId}`);
    console.log('\nCall is active. Keeping room open for 15 seconds so you can hear silence/connection...');

    await new Promise((resolve) => setTimeout(resolve, 15000));

    console.log('\nEnding test call and cleaning up room...');
    await roomService.deleteRoom(roomName);
    console.log('✅ Room deleted. Telephony test completed successfully!\n');
    process.exit(0);

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
