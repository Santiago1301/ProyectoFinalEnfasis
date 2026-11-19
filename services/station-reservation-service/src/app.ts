import { FLAGS, FeatureFlagClient, HttpError, Logger, asyncHandler, createServiceApp } from '@aegisvolt/shared';
import { ReservationRepository } from './repository.ts';

export function buildApp(deps: { repo: ReservationRepository; flags: FeatureFlagClient; logger: Logger }) {
  const { repo, flags, logger } = deps;
  return createServiceApp(logger, (app) => {
    app.get('/stations', asyncHandler(async (_req, res) => res.json(await repo.listStations())));

    app.get(
      '/stations/:stationId',
      asyncHandler(async (req, res) => {
        const station = (await repo.listStations()).find((s) => s.stationId === req.params.stationId);
        if (!station) throw new HttpError(404, 'STATION_NOT_FOUND', 'Electrolinera no encontrada');
        res.json(station);
      }),
    );

    app.get(
      '/reservations/:sagaId',
      asyncHandler(async (req, res) => {
        const r = await repo.getReservation(String(req.params.sagaId));
        if (!r) throw new HttpError(404, 'RESERVATION_NOT_FOUND', 'Reserva no encontrada');
        res.json(r);
      }),
    );

    // SAGA paso 1
    app.post(
      '/reservations',
      asyncHandler(async (req, res) => {
        const { sagaId, stationId, connectorId, fleetId, priority = false } = req.body ?? {};
        if (!sagaId || !stationId || !connectorId || !fleetId) {
          throw new HttpError(400, 'BAD_REQUEST', 'sagaId, stationId, connectorId y fleetId son obligatorios');
        }
        if (priority && !(await flags.isEnabled(FLAGS.ENABLE_FAST_CHARGE_BOOST))) {
          throw new HttpError(403, 'FEATURE_DISABLED', 'ENABLE_FAST_CHARGE_BOOST está deshabilitada en este ambiente');
        }
        const result = await repo.reserve({ sagaId, stationId, connectorId, fleetId, priority: Boolean(priority) });
        req.log.info(result.idempotent ? 'reservation_already_exists' : 'connector_reserved', {
          saga_step: 'RESERVE',
          station_id: stationId,
          connector_id: connectorId,
        });
        res.status(result.idempotent ? 200 : 201).json(result);
      }),
    );

    // Compensación del paso 1
    app.post(
      '/reservations/:sagaId/release',
      asyncHandler(async (req, res) => {
        const result = await repo.release(String(req.params.sagaId), req.body?.reason ?? 'SAGA_COMPENSATION');
        req.log.warn('reservation_released', { saga_step: 'COMPENSATE_RESERVE', ...result, reservation: undefined });
        res.json(result);
      }),
    );

    app.post(
      '/reservations/:sagaId/activate',
      asyncHandler(async (req, res) => res.json(await repo.transition(String(req.params.sagaId), 'ACTIVE'))),
    );

    app.post(
      '/reservations/:sagaId/complete',
      asyncHandler(async (req, res) => res.json(await repo.transition(String(req.params.sagaId), 'COMPLETED'))),
    );
  });
}
