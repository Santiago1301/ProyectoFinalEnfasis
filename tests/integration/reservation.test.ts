import { afterAll, describe, expect, it } from 'vitest';
import { cleanupFixtures, createConnector, uid } from '../helpers.ts';
import { ReservationRepository } from '../../services/station-reservation-service/src/repository.ts';

describe('station-reservation-service ↔ DynamoDB', () => {
  const repo = new ReservationRepository();
  afterAll(cleanupFixtures);

  it('reserva con escritura condicional y es idempotente por sagaId', async () => {
    const { stationId, connectorId } = await createConnector();
    const sagaId = uid('saga');
    const first = await repo.reserve({ sagaId, stationId, connectorId, fleetId: 'f', priority: false });
    const again = await repo.reserve({ sagaId, stationId, connectorId, fleetId: 'f', priority: false });
    expect(first.idempotent).toBe(false);
    expect(again.idempotent).toBe(true);
    expect((await repo.getConnector(stationId, connectorId))?.status).toBe('RESERVED');
  });

  it('rechaza con 409 si otra SAGA ya tiene el conector', async () => {
    const { stationId, connectorId } = await createConnector();
    await repo.reserve({ sagaId: uid('saga'), stationId, connectorId, fleetId: 'f', priority: false });
    await expect(repo.reserve({ sagaId: uid('saga'), stationId, connectorId, fleetId: 'f', priority: false })).rejects.toMatchObject({
      status: 409,
      code: 'CONNECTOR_NOT_AVAILABLE',
    });
  });

  it('la compensación libera el conector y es idempotente', async () => {
    const { stationId, connectorId } = await createConnector();
    const sagaId = uid('saga');
    await repo.reserve({ sagaId, stationId, connectorId, fleetId: 'f', priority: false });
    const first = await repo.release(sagaId, 'TEST');
    const second = await repo.release(sagaId, 'TEST');
    expect(first).toMatchObject({ released: true, idempotent: false });
    expect(second).toMatchObject({ released: true, idempotent: true });
    expect((await repo.getConnector(stationId, connectorId))?.status).toBe('AVAILABLE');
    expect((await repo.getReservation(sagaId))?.status).toBe('RELEASED');
  });

  it('liberar una reserva que nunca existió es un no-op', async () => {
    expect(await repo.release(uid('saga'), 'TEST')).toMatchObject({ released: false, note: 'NO_RESERVATION' });
  });

  it('transiciona RESERVED -> ACTIVE (CHARGING) -> COMPLETED (AVAILABLE)', async () => {
    const { stationId, connectorId } = await createConnector();
    const sagaId = uid('saga');
    await repo.reserve({ sagaId, stationId, connectorId, fleetId: 'f', priority: false });
    await repo.transition(sagaId, 'ACTIVE');
    expect((await repo.getConnector(stationId, connectorId))?.status).toBe('CHARGING');
    await repo.transition(sagaId, 'COMPLETED');
    expect((await repo.getConnector(stationId, connectorId))?.status).toBe('AVAILABLE');
  });
});
