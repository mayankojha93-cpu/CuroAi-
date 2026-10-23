import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authService } from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../config/logger.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * POST /api/auth/login - Authenticate with email & password
 */
authRouter.post('/api/auth/login', async (req: Request, res: Response) => {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: parseResult.error.errors[0]?.message || 'Invalid input' });
    return;
  }

  const { email, password } = parseResult.data;

  try {
    const result = await authService.login(email, password);
    logger.info({ email: result.user.email }, 'User logged in successfully');
    res.json({
      success: true,
      token: result.token,
      user: result.user,
    });
  } catch (err: any) {
    logger.warn({ email, err: err.message }, 'Failed login attempt');
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

/**
 * GET /api/auth/me - Verify current session & return user profile
 */
authRouter.get('/api/auth/me', requireAuth, async (req: Request, res: Response) => {
  res.json({
    authenticated: true,
    user: req.user,
  });
});

/**
 * POST /api/auth/logout - Invalidate user session
 */
authRouter.post('/api/auth/logout', async (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});
