import { SipClient } from 'livekit-server-sdk';
import { RoomConfiguration, RoomAgentDispatch } from '@livekit/protocol';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';

async function main() {
  console.log('\n=========================================');
  console.log(' LiveKit Exotel Inbound SIP Trunk Setup  ');
  console.log('=========================================\n');

  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    console.error('❌ Missing LiveKit credentials in environment!');
    console.error('Please ensure LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are set in .env');
    process.exit(1);
  }

  const sipClient = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  const args = process.argv.slice(2);

  // CLI option: --delete-trunk <trunkId>
  const delTrunkIdx = args.indexOf('--delete-trunk');
  if (delTrunkIdx !== -1 && args[delTrunkIdx + 1]) {
    const id = args[delTrunkIdx + 1];
    console.log(`🗑️ Deleting Inbound SIP Trunk: ${id}...`);
    try {
      await sipClient.deleteSipTrunk(id);
      console.log(`✅ Successfully deleted Inbound Trunk: ${id}\n`);
    } catch (err: any) {
      console.error(`❌ Failed to delete trunk ${id}:`, err.message || err);
    }
    process.exit(0);
  }

  // CLI option: --delete-rule <ruleId>
  const delRuleIdx = args.indexOf('--delete-rule');
  if (delRuleIdx !== -1 && args[delRuleIdx + 1]) {
    const id = args[delRuleIdx + 1];
    console.log(`🗑️ Deleting SIP Dispatch Rule: ${id}...`);
    try {
      await sipClient.deleteSipDispatchRule(id);
      console.log(`✅ Successfully deleted Dispatch Rule: ${id}\n`);
    } catch (err: any) {
      console.error(`❌ Failed to delete dispatch rule ${id}:`, err.message || err);
    }
    process.exit(0);
  }

  try {
    // 1. List existing inbound trunks and dispatch rules
    logger.info('Querying existing LiveKit Inbound SIP trunks and rules...');
    const [existingTrunks, existingRules] = await Promise.all([
      sipClient.listSipInboundTrunk(),
      sipClient.listSipDispatchRule(),
    ]);

    if (existingTrunks.length > 0) {
      console.log(`\n📋 Found ${existingTrunks.length} existing Inbound SIP trunk(s):`);
      for (const t of existingTrunks) {
        console.log(`  - Trunk ID: ${t.sipTrunkId} | Name: "${t.name}" | Numbers: ${t.numbers?.join(', ')}`);
      }
      console.log('\n');
    }

    if (existingRules.length > 0) {
      console.log(`📋 Found ${existingRules.length} existing SIP Dispatch Rule(s):`);
      for (const r of existingRules) {
        console.log(`  - Rule ID: ${r.sipDispatchRuleId} | Name: "${r.name}" | Trunks: ${r.trunkIds?.join(', ')}`);
      }
      console.log('\n');
    }

    if (args.includes('--list')) {
      process.exit(0);
    }

    if (!env.SIP_CALLER_ID) {
      console.error('❌ Missing SIP_CALLER_ID in environment!');
      console.error('Example for Exotel: SIP_CALLER_ID=+9109513886363 (your Exotel ExoPhone)');
      process.exit(1);
    }

    const exoPhone = env.SIP_CALLER_ID;
    const digits = exoPhone.replace(/\D/g, '');
    const numbersSet = new Set<string>([exoPhone]);
    if (digits.startsWith('91')) {
      numbersSet.add(`0${digits.slice(2)}`);
      numbersSet.add(`+910${digits.slice(2)}`);
    } else {
      numbersSet.add(`+91${digits}`);
      numbersSet.add(`0${digits}`);
    }
    const numbers = Array.from(numbersSet);

    const trunkName = `exotel-inbound-${Date.now().toString().slice(-4)}`;
    logger.info({ trunkName, numbers }, 'Creating new LiveKit Inbound SIP trunk for Exotel...');

    // 2. Create Inbound Trunk
    const inboundTrunk = await sipClient.createSipInboundTrunk(
      trunkName,
      numbers,
      {
        authUsername: env.SIP_USERNAME || undefined,
        authPassword: env.SIP_PASSWORD || undefined,
      }
    );

    console.log('✅ Inbound Exotel SIP Trunk created in LiveKit!');
    console.log(`  Trunk ID:      ${inboundTrunk.sipTrunkId}`);
    console.log(`  Name:          ${inboundTrunk.name}`);
    console.log(`  Numbers:       ${inboundTrunk.numbers?.join(', ')}\n`);

    // 3. Create Dispatch Rule to auto-route incoming calls to individual rooms and dispatch Agent Priya
    const ruleName = `exotel-inbound-dispatch-${Date.now().toString().slice(-4)}`;
    logger.info({ ruleName, trunkId: inboundTrunk.sipTrunkId }, 'Creating LiveKit SIP Dispatch Rule...');

    const dispatchRule = await sipClient.createSipDispatchRule(
      {
        type: 'individual',
        roomPrefix: 'inbound-call-',
      },
      {
        name: ruleName,
        trunkIds: [inboundTrunk.sipTrunkId],
        roomConfig: new RoomConfiguration({
          agents: [
            new RoomAgentDispatch({
              agentName: env.AGENT_NAME,
              metadata: JSON.stringify({ direction: 'inbound' }),
            }),
          ],
        }),
      }
    );

    console.log('✅ SIP Dispatch Rule created in LiveKit!');
    console.log(`  Rule ID:       ${dispatchRule.sipDispatchRuleId}`);
    console.log(`  Name:          ${dispatchRule.name}`);
    console.log(`  Room Prefix:   inbound-call-`);
    console.log(`  Agent Target:  ${env.AGENT_NAME} (direction: inbound)\n`);

    console.log(`--------------------------------------------------`);
    console.log(`👉 Add or update in your .env file:`);
    console.log(`   SIP_INBOUND_TRUNK_ID=${inboundTrunk.sipTrunkId}`);
    console.log(`   SIP_DISPATCH_RULE_ID=${dispatchRule.sipDispatchRuleId}`);
    console.log(`--------------------------------------------------\n`);

  } catch (err: any) {
    console.error('\n❌ Failed to setup Inbound Exotel SIP Trunk:');
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
