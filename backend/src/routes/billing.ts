import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/index.js';
import { validateRequest } from '../middleware/validate.js';
import { logger } from '../config/logger.js';

export const billingRouter = Router();

const addCreditsSchema = {
  body: z.object({
    amount: z.number().int().positive({ message: 'Amount must be a positive integer' }),
  }),
};

/**
 * GET /api/billing/balance - Fetch current credit balance
 */
billingRouter.get('/api/billing/balance', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const query = `SELECT available_credits, currency, updated_at FROM billing_accounts WHERE id = 'default' LIMIT 1`;
    const result = await pool.query(query);
    if (result.rows.length === 0) {
      return res.json({ success: true, available_credits: 21874, currency: 'credits' });
    }
    return res.json({
      success: true,
      available_credits: result.rows[0].available_credits,
      currency: result.rows[0].currency,
      updated_at: result.rows[0].updated_at,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/billing/add-credits - Add credits to balance (+1,000, +5,000, +10,000)
 */
billingRouter.post(
  '/api/billing/add-credits',
  validateRequest(addCreditsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount } = req.body;
      const query = `
        INSERT INTO billing_accounts (id, available_credits, updated_at)
        VALUES ('default', 21874 + $1, NOW())
        ON CONFLICT (id)
        DO UPDATE SET available_credits = billing_accounts.available_credits + $1,
                      updated_at = NOW()
        RETURNING available_credits, updated_at
      `;
      const result = await pool.query(query, [amount]);
      logger.info({ amount, newBalance: result.rows[0].available_credits }, 'Added credits to billing balance');
      return res.json({
        success: true,
        message: `Successfully added ${amount} credits`,
        available_credits: result.rows[0].available_credits,
        updated_at: result.rows[0].updated_at,
      });
    } catch (err) {
      return next(err);
    }
  }
);
