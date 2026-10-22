import { SipClient } from 'livekit-server-sdk';
import { env } from '../src/config/env.js';

async function main() {
  const sip = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  console.log('--- Outbound Trunks ---');
  const outTrunks = await sip.listSipOutboundTrunk();
  for (const t of outTrunks) {
    console.log({
      id: t.sipTrunkId,
      name: t.name,
      address: t.address,
      transport: t.transport,
      numbers: t.numbers,
      authUsername: t.authUsername,
    });
  }

  console.log('\n--- Inbound Trunks ---');
  const inTrunks = await sip.listSipInboundTrunk();
  for (const t of inTrunks) {
    console.log({
      id: t.sipTrunkId,
      name: t.name,
      numbers: t.numbers,
    });
  }

  console.log('\n--- Dispatch Rules ---');
  const rules = await sip.listSipDispatchRule();
  for (const r of rules) {
    console.log({
      id: r.sipDispatchRuleId,
      name: r.name,
      trunkIds: r.trunkIds,
      rule: r.rule,
    });
  }
}

main().catch(console.error);
