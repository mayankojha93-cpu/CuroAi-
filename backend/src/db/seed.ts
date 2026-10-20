import { pool } from './index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export async function seedCustomer() {
  const phone = env.TEST_PHONE;
  const name = env.TEST_CUSTOMER_NAME;
  const address = env.TEST_CUSTOMER_ADDRESS;
  const language = 'hi';

  logger.info({ phone, name, address }, 'Seeding test customer...');

  const queryText = `
    INSERT INTO customers (name, phone, address, language)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (phone)
    DO UPDATE SET 
      name = EXCLUDED.name,
      address = EXCLUDED.address,
      language = EXCLUDED.language
    RETURNING id, name, phone, address, language, created_at;
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
  seedCustomer()
    .then((c) => {
      console.log(`\n🎉 Customer ready! ID: ${c.id}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
