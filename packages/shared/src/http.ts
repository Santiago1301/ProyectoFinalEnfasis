import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.ts';
import { getEnvironment } from './config.ts';

export const CORRELATION_HEADER = 'x-correlation-id';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
    log: Logger;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** App Express base: JSON, correlation_id, health/readiness y manejo de errores. */
export function createServiceApp(logger: Logger, register: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.correlationId = (req.header(CORRELATION_HEADER) as string) || randomUUID();
    req.log = logger.child({ correlation_id: req.correlationId });
    res.setHeader(CORRELATION_HEADER, req.correlationId);
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/health')) return;
      req.log.info('http_request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      });
    });
    next();
  });

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', (_req, res) => {
    res.json({
      status: 'ok',
      service: logger.service,
      environment: getEnvironment(),
      version: process.env.APP_VERSION ?? 'local',
      track: process.env.DEPLOY_TRACK ?? 'stable',
    });
  });

  register(app);

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      req.log.warn('request_rejected', { code: err.code, error: err.message, ...err.details });
      res.status(err.status).json({ error: err.code, message: err.message, ...err.details });
      return;
    }
    req.log.error('unhandled_error', { error: (err as Error).message, stack: (err as Error).stack });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: (err as Error).message });
  });
  return app;
}

/** Envuelve handlers async para que los errores lleguen al middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function listen(app: express.Express, logger: Logger, defaultPort: number) {
  const port = Number(process.env.PORT ?? defaultPort);
  const server = app.listen(port, () => logger.info('service_started', { port }));
  const shutdown = async () => {
    logger.info('service_stopping');
    await logger.flush();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
