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

console.log('\n--- Testing Target Columns CSV Parsing ---');
const targetCsv = `R. DATE,SUBS_DEL_NO,SERVICE_END,ADDRESS,CUST_EMAIL,CONTACT_PHONE1,CONTACT_PHONE2,SUBS_NAME,CUSTOMER_IDENTIFER
29 Aug 26,01121344121_wifi,27 Aug 26,"Delhi, 110011, burari, sant nagar",rahul.sharma@example.com,+919876543210,+919811223344,Rahul Sharma,20022941256
29 Aug 26,01121344122_wifi,28 Aug 26,"Flat 204, Pocket 2, Mayur Vihar Phase 1, New Delhi - 110091",priya.patel@example.com,+919811223344,,Priya Patel,20022941257
29 Aug 26,09811122233_wifi,25 Aug 26,"C-12, Green Park Extension, New Delhi - 110016",amit.verma@example.com,+919822334455,+919833445566,Amit Verma,20022941258`;

const targetLeads = parseCsvToLeads(targetCsv);
console.log(`Parsed ${targetLeads.length} target leads:`);
console.log(JSON.stringify(targetLeads, null, 2));

const lead1 = targetLeads[0];
if (
  lead1.name === 'Rahul Sharma' &&
  lead1.phone === '+919876543210' &&
  lead1.alternate_phone === '+919811223344' &&
  lead1.cust_email === 'rahul.sharma@example.com' &&
  lead1.customer_identifier === '20022941256' &&
  lead1.subs_del_no === '01121344121_wifi' &&
  lead1.service_end_date === '2026-08-27' &&
  lead1.r_date === '2026-08-29'
) {
  console.log('\n✅ ALL TARGET COLUMN CHECKS PASSED!');
} else {
  console.error('\n❌ TARGET COLUMN CHECKS FAILED');
  process.exit(1);
}
