import { pool } from './index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { authService } from '../services/authService.js';

export async function seedCustomer() {
  const phone = env.TEST_PHONE;
  const name = env.TEST_CUSTOMER_NAME;
  const address = env.TEST_CUSTOMER_ADDRESS;
  const language = 'hi';

  logger.info({ phone, name, address }, 'Seeding test customer...');

  const queryText = `
    INSERT INTO customers (
      name, phone, address, language,
      account_no, subs_del_no, service_end_date, r_date,
      total_attempts, max_attempts, next_attempt_time
    )
    VALUES ($1, $2, $3, $4, '20022941256', '01121344121_wifi', '2026-08-27', '2026-08-29', 0, 3, NOW())
    ON CONFLICT (phone)
    DO UPDATE SET 
      name = EXCLUDED.name,
      address = EXCLUDED.address,
      language = EXCLUDED.language,
      account_no = EXCLUDED.account_no,
      subs_del_no = EXCLUDED.subs_del_no,
      service_end_date = EXCLUDED.service_end_date,
      r_date = EXCLUDED.r_date
    RETURNING id, name, phone, address, language, account_no, subs_del_no, created_at;
  `;

  const res = await pool.query(queryText, [name, phone, address, language]);
  const customer = res.rows[0];

  logger.info(
    { customerId: customer.id, phone: customer.phone, name: customer.name },
    '✅ Test customer seeded successfully'
  );

  return customer;
}

export async function seedRealEstateLead() {
  const phone = env.TEST_PHONE || '+919811122233';
  const name = 'Vikramaditya Singhania';
  const email = 'vikram@example.com';
  const location = 'DLF The Camellias, Golf Course Road, Gurgaon Sector 42';

  logger.info({ phone, name, email, location }, 'Seeding test real estate lead...');

  const queryText = `
    INSERT INTO real_estate_leads (
      id, owner_name, phone, email, property_location, preferred_language, lead_status, current_disposition, notes
    )
    VALUES ('e1000000-0000-0000-0000-000000000001', $1, $2, $3, $4, 'hi', 'NEW', 'Pending Outreach', 'Owner of luxury apartment in Gurgaon')
    ON CONFLICT (phone)
    DO UPDATE SET
      owner_name = EXCLUDED.owner_name,
      email = EXCLUDED.email,
      property_location = EXCLUDED.property_location
    RETURNING id, owner_name, phone, email, property_location;
  `;

  const res = await pool.query(queryText, [name, phone, email, location]);
  const lead = res.rows[0];

  logger.info(
    { leadId: lead.id, phone: lead.phone, name: lead.owner_name },
    '✅ Test real estate lead seeded successfully'
  );

  return lead;
}

// Run directly if invoked via CLI
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  Promise.all([authService.ensureDefaultAdmin(), seedCustomer(), seedRealEstateLead()])
    .then(([, c, l]) => {
      console.log(`\n🎉 Admin user ready, Telecom Customer ready (ID: ${c.id}), and Real Estate Lead ready (ID: ${l.id})!`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
