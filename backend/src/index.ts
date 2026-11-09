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
import { downloadPendingRecordings, getRecordingsDir } from './services/recordingDownloader.js';
import { s3Service } from './services/s3Service.js';
import { authRouter } from './routes/auth.js';
import { campaignsRouter } from './routes/campaigns.js';
import { billingRouter } from './routes/billing.js';
import { realEstateRouter } from './routes/realEstate.js';
import { requireAuth } from './middleware/auth.js';
import { authService } from './services/authService.js';
import { realEstateCallService } from './services/realEstateCallService.js';

export const app = express();

// Disable ETag generation to prevent 304 Not Modified caching on API responses
app.set('etag', false);

// Prevent browser/client-side caching on all API responses
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Enable CORS for frontend Vite dev server and production
app.use(cors());

// Structured request logging with Pino (filtered to suppress repetitive dashboard polling spam)
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => {
        const url = req.url || '';
        // Silence health checks, favicon, and routine frontend polling GET requests
        return (
          url === '/health' ||
          url.startsWith('/favicon') ||
          (req.method === 'GET' && (
            url.startsWith('/api/calls') ||
            url.startsWith('/api/retries') ||
            url.startsWith('/api/campaigns') ||
            url.startsWith('/api/billing') ||
            url.startsWith('/api/auth/me') ||
            url.startsWith('/api/leads') ||
            url.startsWith('/api/real-estate')
          ))
        );
      },
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode}: ${err.message}`,
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
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
app.use(internalRouter);
app.use(authRouter);
app.use(realEstateRouter);
app.use(requireAuth, callsRouter);
app.use(requireAuth, campaignsRouter);
app.use(requireAuth, billingRouter);

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

    // Ensure default admin user is seeded
    authService.ensureDefaultAdmin().catch((err: any) => {
      logger.error({ err }, 'Error checking/seeding default admin');
    });

    // Auto-backfill any missing real estate property details from call transcripts
    realEstateCallService.autoBackfillMissingDetails().catch((err: any) => {
      logger.error({ err }, 'Error auto-backfilling real estate property details');
    });

    // Start stuck calls reconciler every 30 seconds
    sweeperInterval = setInterval(() => {
      callService.reconcileStuckCalls().catch((err: any) => {
        logger.error({ err }, 'Error running stuck calls reconciler');
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

    // Sync any local recordings to AWS S3 on startup
    if (s3Service.isConfigured()) {
      s3Service.syncLocalRecordings(getRecordingsDir()).catch((err) => {
        logger.warn({ err: err?.message }, 'Error during startup S3 recording sync');
      });
    }
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
