import { FLAGS, FeatureFlagClient, HttpError, Logger, asyncHandler, createServiceApp } from '@aegisvolt/shared';
import type { DispatchRepository } from './repository.ts';

export const HARDWARE_FAULT_CODE = 'GROUND_FAULT_DETECTED';

export function buildApp(deps: { repo: DispatchRepository; flags: FeatureFlagClient; logger: Logger }) {
  const { repo, flags, logger } = deps;
  return createServiceApp(logger, (app) => {
    app.get(
      '/sessions',
      asyncHandler(async (req, res) => res.json(await repo.listSessions(req.query.status as never))),
    );

    app.get(
      '/sessions/:sagaId',
      asyncHandler(async (req, res) => {
        const session = await repo.getSession(String(req.params.sagaId));
        if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Sesión no encontrada');
        res.json(session);
      }),
    );

    app.get(
      '/sessions/:sagaId/telemetry',
      asyncHandler(async (req, res) =>
        res.json(await repo.listTelemetry(String(req.params.sagaId), Number(req.query.limit ?? 60))),
      ),
    );

    // SAGA paso 3: activación física del cargador
    app.post(
      '/sessions',
      asyncHandler(async (req, res) => {
        const { sagaId, stationId, connectorId, energyKwh, powerKw } = req.body ?? {};
        if (!sagaId || !stationId || !connectorId) {
          throw new HttpError(400, 'BAD_REQUEST', 'sagaId, stationId y connectorId son obligatorios');
        }
        const fault = await flags.isEnabled(FLAGS.SIMULATE_CHARGER_HARDWARE_FAULT);
        const now = new Date().toISOString();
        const { session, created } = await repo.createSession({
          sagaId,
          stationId,
          connectorId,
          status: fault ? 'FAILED' : 'ACTIVE',
          powerKw: Number(powerKw ?? 50),
          energyKwhTarget: Number(energyKwh ?? 20),
          deliveredKwh: 0,
          faultCode: fault ? HARDWARE_FAULT_CODE : undefined,
          startedAt: now,
          updatedAt: now,
        });

        // Idempotencia: si la sesión ya existía, se responde con su resultado original.
        if (session.status === 'FAILED') {
          req.log.error('charger_hardware_fault', {
            saga_step: 'DISPATCH',
            station_id: stationId,
            connector_id: connectorId,
            fault_code: session.faultCode,
            injected_by_flag: fault,
          });
          throw new HttpError(502, 'HARDWARE_FAULT', `El cargador reportó falla física: ${session.faultCode}`, {
            faultCode: session.faultCode,
          });
        }
        req.log.info(created ? 'charging_started' : 'charging_already_started', {
          saga_step: 'DISPATCH',
          station_id: stationId,
          connector_id: connectorId,
        });
        res.status(created ? 201 : 200).json({ session, idempotent: !created });
      }),
    );

    app.post(
      '/sessions/:sagaId/stop',
      asyncHandler(async (req, res) => {
        const session = await repo.stop(String(req.params.sagaId));
        if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Sesión no encontrada');
        req.log.info('charging_stopped', { delivered_kwh: session.deliveredKwh });
        res.json(session);
      }),
    );
  });
}
