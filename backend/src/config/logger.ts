import pino from 'pino';

let hasPinoPretty = false;
try {
  require.resolve('pino-pretty');
  hasPinoPretty = true;
} catch {
  hasPinoPretty = false;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production' && hasPinoPretty
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});
