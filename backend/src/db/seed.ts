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

// Run directly if invoked via CLI
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  Promise.all([authService.ensureDefaultAdmin(), seedCustomer()])
    .then(([, c]) => {
      console.log(`\n🎉 Admin user ready & Test customer ready! ID: ${c.id}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
