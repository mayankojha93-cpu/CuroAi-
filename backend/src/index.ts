import express, { Request, Response } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { healthRouter } from './routes/health.js';
import { callsRouter } from './routes/calls.js';
import { internalRouter } from './routes/internal.js';
import { webhooksRouter } from './routes/webhooks.js';
import { callService } from './services/callService.js';

export const app = express();

// Capture raw body for webhook verification while parsing JSON for all endpoints
app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      (req as any).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// Structured request logging with Pino
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  })
);

// Register routes
app.use(healthRouter);
app.use(callsRouter);
app.use(internalRouter);
app.use(webhooksRouter);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// Central error handler
app.use(errorHandler);

// Background sweeper timer
let sweeperInterval: NodeJS.Timeout | null = null;

// Start server if not imported as module in tests
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 AI Calling Backend listening on port ${env.PORT} (${env.NODE_ENV})`);
    logger.info(`👉 Health check: http://localhost:${env.PORT}/health`);
    logger.info(`👉 Calls API:    http://localhost:${env.PORT}/calls`);

    // Start stuck calls sweeper every 30 seconds
    sweeperInterval = setInterval(() => {
      callService.sweepStuckCalls().catch((err) => {
        logger.error({ err }, 'Error running stuck calls sweeper');
      });
    }, 30000);
  });

  const gracefulShutdown = (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    if (sweeperInterval) {
      clearInterval(sweeperInterval);
    }
    server.close(async () => {
      logger.info('HTTP server closed.');
      try {
        await pool.end();
        logger.info('Database pool closed.');
      } catch (err) {
        logger.error({ err }, 'Error closing database pool');
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
