import { Pool, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL client error on idle connection');
});

export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  logger.debug({ text, duration, rows: res.rowCount }, 'Executed PostgreSQL query');
  return res;
}

export async function checkDbHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
