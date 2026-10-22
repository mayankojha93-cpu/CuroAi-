import { SipClient } from 'livekit-server-sdk';
import { SIPTransport } from '@livekit/protocol';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';

async function main() {
  console.log('\n=========================================');
  console.log(' LiveKit Exotel Outbound SIP Trunk Setup  ');
  console.log('=========================================\n');

  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    console.error('❌ Missing LiveKit credentials in environment!');
    console.error('Please ensure LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are set in .env');
    process.exit(1);
  }

  const sipClient = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

  // Handle optional CLI commands: --list or --delete <trunkId>
  const args = process.argv.slice(2);
  const deleteIndex = args.indexOf('--delete');
  if (deleteIndex !== -1 && args[deleteIndex + 1]) {
    const targetId = args[deleteIndex + 1];
    console.log(`🗑️ Deleting SIP trunk: ${targetId}...`);
    try {
      await sipClient.deleteSipTrunk(targetId);
      console.log(`✅ Successfully deleted trunk: ${targetId}\n`);
    } catch (err: any) {
      console.error(`❌ Failed to delete trunk ${targetId}:`, err.message || err);
    }
    process.exit(0);
  }

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

    if (args.includes('--list')) {
      process.exit(0);
    }

    if (!env.SIP_DOMAIN) {
      console.error('❌ Missing SIP_DOMAIN in environment!');
      console.error('Example for Exotel: SIP_DOMAIN=curoai1.pstn.exotel.com:5070 (or pstn.exotel.com:5070)');
      process.exit(1);
    }

    if (!env.SIP_CALLER_ID) {
      console.error('❌ Missing SIP_CALLER_ID in environment!');
      console.error('Example for Exotel: SIP_CALLER_ID=+9109513886363 (your Exotel ExoPhone)');
      process.exit(1);
    }

    // 2. Provision new trunk
    const provider = 'exotel';
    const trunkName = `${provider}-outbound-${Date.now().toString().slice(-4)}`;
    const address = env.SIP_DOMAIN;

    const callerId = env.SIP_CALLER_ID;
    const digits = callerId.replace(/\D/g, '');
    const numbersSet = new Set<string>([callerId]);
    if (digits.startsWith('91')) {
      numbersSet.add(`0${digits.slice(2)}`);
      numbersSet.add(`+910${digits.slice(2)}`);
    } else {
      numbersSet.add(`+91${digits}`);
      numbersSet.add(`0${digits}`);
    }
    const numbers = Array.from(numbersSet);

    logger.info({ trunkName, address, numbers }, 'Creating new LiveKit outbound Exotel SIP trunk...');

    const trunk = await sipClient.createSipOutboundTrunk(
      trunkName,
      address,
      numbers,
      {
        authUsername: env.SIP_USERNAME || undefined,
        authPassword: env.SIP_PASSWORD || undefined,
        transport: SIPTransport.SIP_TRANSPORT_TCP,
      }
    );

    console.log('✅ Outbound Exotel SIP Trunk successfully created in LiveKit!\n');
    console.log(`--------------------------------------------------`);
    console.log(`Trunk ID:      ${trunk.sipTrunkId}`);
    console.log(`Name:          ${trunk.name}`);
    console.log(`Address:       ${trunk.address}`);
    console.log(`Caller ID:     ${trunk.numbers?.join(', ')}`);
    console.log(`--------------------------------------------------\n`);
    console.log(`👉 Please set this in your .env file:`);
    console.log(`   SIP_OUTBOUND_TRUNK_ID=${trunk.sipTrunkId}\n`);

  } catch (err: any) {
    console.error('\n❌ Failed to create outbound Exotel SIP trunk:');
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
