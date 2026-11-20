import { describe, expect, it } from 'vitest';
import { uid } from '../helpers.ts';
import { DispatchRepository } from '../../services/energy-dispatch-service/src/repository.ts';
import { ConcurrentSagaUpdateError, DynamoSagaStore } from '../../services/graphql-gateway/src/saga/store.ts';
import type { SagaRecord } from '../../services/graphql-gateway/src/saga/types.ts';

describe('energy-dispatch-service ↔ DynamoDB', () => {
  it('crear la sesión dos veces con el mismo sagaId no duplica la orden al cargador', async () => {
    const repo = new DispatchRepository();
    const now = new Date().toISOString();
    const session = {
      sagaId: uid('saga'), stationId: 's', connectorId: 'c1', status: 'ACTIVE' as const,
      powerKw: 50, energyKwhTarget: 10, deliveredKwh: 0, startedAt: now, updatedAt: now,
    };
    expect((await repo.createSession(session)).created).toBe(true);
    expect((await repo.createSession({ ...session, status: 'FAILED' })).created).toBe(false);
    expect((await repo.getSession(session.sagaId))?.status).toBe('ACTIVE');
  });
});

describe('log de SAGAs ↔ DynamoDB', () => {
  it('el bloqueo optimista impide que dos réplicas sobrescriban la misma SAGA', async () => {
    const store = new DynamoSagaStore();
    const now = new Date().toISOString();
    const saga: SagaRecord = {
      sagaId: uid('saga'), correlationId: 'x', status: 'STARTED', environment: 'test', fleetId: 'f',
      stationId: 's', connectorId: 'c1', energyKwh: 1, fastChargeBoost: false, attemptedSteps: [], steps: [],
      createdAt: now, updatedAt: now, version: 0,
    };
    expect(await store.create(saga)).toBe(true);
    expect(await store.create(saga)).toBe(false);
    await store.save({ ...saga, status: 'RESERVED' });
    await expect(store.save({ ...saga, status: 'PAID' })).rejects.toBeInstanceOf(ConcurrentSagaUpdateError);
  });
});
