import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';

export class AppError extends Error {
  public statusCode: number;
  public details?: any;

  constructor(message: string, statusCode = 500, details?: any) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    logger.warn({ path: req.path, issues: err.issues }, 'Input validation error');
    return res.status(400).json({
      error: 'Validation Error',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const statusCode = err.statusCode || (err.status >= 400 && err.status < 600 ? err.status : 500);
  const message = err.message || 'Internal Server Error';

  logger.error(
    {
      err: {
        message: err.message,
        stack: err.stack,
        statusCode,
        details: err.details,
      },
      req: {
        method: req.method,
        url: req.url,
      },
    },
    'Request handler error'
  );

  return res.status(statusCode).json({
    error: message,
    ...(err.details ? { details: err.details } : {}),
  });
}
