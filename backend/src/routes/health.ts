import { Router, Request, Response } from 'express';
import { checkDbHealth } from '../db/index.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req: Request, res: Response) => {
  const dbHealth = await checkDbHealth();
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();

  const isHealthy = dbHealth.ok;

  const payload = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(uptime),
    database: {
      connected: dbHealth.ok,
      latencyMs: dbHealth.latencyMs,
      error: dbHealth.error,
    },
    system: {
      nodeVersion: process.version,
      memory: {
        rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      },
    },
  };

  return res.status(isHealthy ? 200 : 503).json(payload);
});
