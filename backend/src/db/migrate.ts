import fs from 'fs';
import path from 'path';
import { pool } from './index.js';
import { logger } from '../config/logger.js';

export async function runMigrations() {
  const client = await pool.connect();
  try {
    logger.info('Starting database migrations...');
    await client.query('BEGIN');

    // Create migrations tracking table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const candidates = [
      path.resolve(__dirname, '../../migrations'),
      path.resolve(__dirname, '../../../migrations'),
      path.resolve(process.cwd(), 'migrations'),
    ];
    const migrationsDir = candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const existing = await client.query('SELECT name FROM _migrations WHERE name = $1', [file]);
      if (existing.rows.length === 0) {
        logger.info(`Applying migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        logger.info(`Successfully applied migration: ${file}`);
      } else {
        logger.info(`Migration already applied, skipping: ${file}`);
      }
    }

    await client.query('COMMIT');
    logger.info('All database migrations completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Error running migrations, rolled back');
    throw err;
  } finally {
    client.release();
  }
}

// Run directly if invoked via CLI
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
