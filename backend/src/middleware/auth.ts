import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { authService, UserPayload } from '../services/authService.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

/**
 * Middleware requiring a valid JWT Bearer token
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Allow internal service-to-service endpoints and health check to bypass JWT
  if (req.path.startsWith('/internal/') || req.path === '/health') {
    return next();
  }

  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-access-token'] as string);

  if (!token) {
    res.status(401).json({ error: 'Authentication token required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as UserPayload;
    const user = await authService.getUserById(decoded.id);

    if (!user) {
      res.status(401).json({ error: 'User session invalid or deactivated' });
      return;
    }

    req.user = user;
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}
