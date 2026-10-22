import { parseCsvToLeads, normalizePhone, normalizeDate } from '../src/utils/csvParser.js';

console.log('--- Testing Date Normalization ---');
const dateTests = [
  '29 Aug 26',
  '27 Aug 26',
  '2026-08-29',
  '29/08/2026',
  '29-08-2026',
];
for (const d of dateTests) {
  console.log(`"${d}" -> "${normalizeDate(d)}"`);
}

console.log('\n--- Testing Phone Extraction and E.164 Normalization ---');
const phoneTests = [
  { phone: undefined, subsDelNo: '01121344121_wifi' },
  { phone: '9811122233', subsDelNo: '01121344121_wifi' },
  { phone: '+919811122233', subsDelNo: '01121344121_wifi' },
  { phone: undefined, subsDelNo: '9811122233_wifi' },
];
for (const t of phoneTests) {
  console.log(`Phone: ${t.phone}, Subs: ${t.subsDelNo} -> "${normalizePhone(t.phone, t.subsDelNo)}"`);
}

console.log('\n--- Testing Sample CSV Parsing from User Image ---');
const sampleCsv = `R. Date,Check,SUBS_DEL_NO,ACCOUNT_NO,SERVICE_END,Address
29 Aug 26,.,01121344121_wifi,20022941256,27 Aug 26,"Delhi, 110011, burari, sant nagar"
29 Aug 26,.,01121344122_wifi,20022941257,28 Aug 26,"Flat 204, Pocket 2, Mayur Vihar Phase 1, New Delhi - 110091"
29 Aug 26,.,09811122233_wifi,20022941258,25 Aug 26,"C-12, Green Park Extension, New Delhi - 110016"`;

const leads = parseCsvToLeads(sampleCsv);
console.log(`Parsed ${leads.length} leads:`);
console.log(JSON.stringify(leads, null, 2));

if (leads.length === 3 && leads[0].phone === '+911121344121' && leads[0].service_end_date === '2026-08-27') {
  console.log('\n✅ ALL VERIFICATION CHECKS PASSED!');
} else {
  console.error('\n❌ VERIFICATION FAILED');
  process.exit(1);
}
