import express, { Request, Response } from 'express';
import cors from 'cors';
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
import { downloadPendingRecordings } from './services/recordingDownloader.js';

export const app = express();

// Enable CORS for frontend Vite dev server and production
app.use(cors());

// Structured request logging with Pino
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  })
);

// ──────────────────────────────────────────────────────────────────────────
// LiveKit webhook MUST be mounted BEFORE the body parsers below.
// LiveKit signs the exact raw bytes (content-type: application/webhook+json); webhooksRouter uses
// express.raw() itself, so the untouched Buffer reaches the signature check.
// ──────────────────────────────────────────────────────────────────────────
app.use(webhooksRouter);

// Body parsers for all other endpoints
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

// Register routes
app.use(healthRouter);
app.use(callsRouter);
app.use(internalRouter);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// Central error handler
app.use(errorHandler);

// Background timers
let sweeperInterval: NodeJS.Timeout | null = null;
let recordingInterval: NodeJS.Timeout | null = null;

// Start server if not imported as module in tests
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 AI Calling Backend listening on port ${env.PORT} (${env.NODE_ENV})`);
    logger.info(`👉 Health check: http://localhost:${env.PORT}/health`);
    logger.info(`👉 Calls API:    http://localhost:${env.PORT}/calls`);

    // Start stuck calls sweeper every 30 seconds
    sweeperInterval = setInterval(() => {
      callService.sweepStuckCalls().catch((err: any) => {
        logger.error({ err }, 'Error running stuck calls sweeper');
      });
    }, 30000);

    // Start recording downloader every 5 minutes
    // Per spec: Exotel recording appears 1–15 min after call, valid for 24 h
    recordingInterval = setInterval(() => {
      downloadPendingRecordings().catch((err: any) => {
        logger.error({ err }, 'Error running recording downloader');
      });
    }, 5 * 60 * 1000);
    // Run once on startup to catch any recordings missed during downtime
    downloadPendingRecordings().catch(() => {});
  });

  const gracefulShutdown = (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    if (sweeperInterval) clearInterval(sweeperInterval);
    if (recordingInterval) clearInterval(recordingInterval);
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
