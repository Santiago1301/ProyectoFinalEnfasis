import type { Logger } from '@aegisvolt/shared';
import { nextTelemetry } from './charger.ts';
import type { DispatchRepository } from './repository.ts';

const INTERVAL_MS = Number(process.env.TELEMETRY_INTERVAL_MS ?? 5000);

/** Registra telemetría periódica de las sesiones activas. */
export function startTelemetryLoop(repo: DispatchRepository, logger: Logger) {
  const timer = setInterval(async () => {
    try {
      const now = Date.now();
      for (const session of await repo.listSessions('ACTIVE')) {
        const elapsed = now - (session.lastTickAt ?? Date.parse(session.startedAt));
        const point = nextTelemetry(session, elapsed, new Date(now));
        const done = point.deliveredKwh >= session.energyKwhTarget;
        const won = await repo.tick(session.sagaId, point.deliveredKwh, done ? 'COMPLETED' : 'ACTIVE', now, INTERVAL_MS - 500);
        if (!won) continue; // otra réplica ya procesó este tick
        await repo.addTelemetry(session.sagaId, point);
        if (done) logger.info('charging_completed', { correlation_id: session.sagaId, delivered_kwh: point.deliveredKwh });
      }
    } catch (err) {
      logger.error('telemetry_loop_failed', { error: (err as Error).message });
    }
  }, INTERVAL_MS);
  timer.unref();
  return timer;
}
