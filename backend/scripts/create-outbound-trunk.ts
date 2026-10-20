import { SipClient } from 'livekit-server-sdk';
import { SIPTransport } from '@livekit/protocol';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';

async function main() {
  console.log('\n=========================================');
  console.log(' LiveKit Outbound SIP Trunk Provisioning ');
  console.log('=========================================\n');

  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    console.error('❌ Missing LiveKit credentials in environment!');
    console.error('Please ensure LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are set in .env');
    process.exit(1);
  }

  if (!env.SIP_DOMAIN) {
    console.error('❌ Missing SIP_DOMAIN in environment!');
    console.error('Example: SIP_DOMAIN=curoai-livekit.pstn.twilio.com');
    process.exit(1);
  }

  if (!env.SIP_CALLER_ID) {
    console.error('❌ Missing SIP_CALLER_ID in environment!');
    console.error('Example: SIP_CALLER_ID=+17816615419');
    process.exit(1);
  }

  const sipClient = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

  try {
    // 1. List existing trunks first
    logger.info('Querying existing LiveKit outbound SIP trunks...');
    const existingTrunks = await sipClient.listSipOutboundTrunk();

    if (existingTrunks.length > 0) {
      console.log(`\n📋 Found ${existingTrunks.length} existing outbound trunk(s):`);
      for (const t of existingTrunks) {
        console.log(`  - ID: ${t.sipTrunkId} | Name: "${t.name}" | Host: ${t.address} | Numbers: ${t.numbers?.join(', ')}`);
      }
      console.log('\n');
    }

    // 2. Provision new trunk
    const provider = env.SIP_PROVIDER || 'sip';
    const trunkName = `${provider}-outbound-${Date.now().toString().slice(-4)}`;
    const address = env.SIP_DOMAIN;
    const numbers = [env.SIP_CALLER_ID];

    logger.info({ trunkName, address, numbers }, 'Creating new LiveKit outbound SIP trunk...');

    const trunk = await sipClient.createSipOutboundTrunk(
      trunkName,
      address,
      numbers,
      {
        authUsername: env.SIP_USERNAME || undefined,
        authPassword: env.SIP_PASSWORD || undefined,
        transport: SIPTransport.SIP_TRANSPORT_AUTO,
      }
    );

    console.log('✅ Outbound SIP Trunk successfully created in LiveKit!\n');
    console.log(`--------------------------------------------------`);
    console.log(`Trunk ID:      ${trunk.sipTrunkId}`);
    console.log(`Name:          ${trunk.name}`);
    console.log(`Address:       ${trunk.address}`);
    console.log(`Caller ID:     ${trunk.numbers?.join(', ')}`);
    console.log(`--------------------------------------------------\n`);
    console.log(`👉 Please set this in your .env file:`);
    console.log(`   SIP_OUTBOUND_TRUNK_ID=${trunk.sipTrunkId}\n`);

  } catch (err: any) {
    console.error('\n❌ Failed to create outbound SIP trunk:');
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
