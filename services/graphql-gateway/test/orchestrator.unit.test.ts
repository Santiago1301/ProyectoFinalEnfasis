import { beforeEach, describe, expect, it } from 'vitest';
import { FLAGS, Logger } from '@aegisvolt/shared';
import { ServiceError } from '../src/clients.ts';
import { SagaOrchestrator } from '../src/saga/orchestrator.ts';
import { InMemorySagaStore } from '../src/saga/store.ts';
import type { SagaParticipants } from '../src/saga/types.ts';

/**
 * Participantes falsos con estado en memoria que imitan las garantías de
 * idempotencia de los servicios reales.
 */
function fakeWorld() {
  const state = {
    connector: { status: 'AVAILABLE', sagaId: undefined as string | undefined },
    balance: 100_000,
    charges: new Map<string, number>(),
    refunds: new Set<string>(),
    sessions: new Map<string, string>(),
    calls: [] as string[],
    hardwareFault: false,
    failRefundTimes: 0,
  };
  const participants: SagaParticipants = {
    async getConnector() {
      return { powerKw: 150, ultraFast: true, status: state.connector.status };
    },
    async quote({ energyKwh }) {
      return { ratePerKwh: 1500, surgeMultiplier: 1, surgeActive: false, peakHour: false, boostFee: 0, amount: energyKwh * 1500, currency: 'COP' };
    },
    async reserve({ sagaId }) {
      state.calls.push('reserve');
      if (state.connector.sagaId === sagaId) return;
      if (state.connector.status !== 'AVAILABLE') throw new ServiceError('reservation', 409, 'CONNECTOR_NOT_AVAILABLE', 'ocupado');
      state.connector = { status: 'RESERVED', sagaId };
    },
    async releaseReservation(sagaId) {
      state.calls.push('release');
      if (state.connector.sagaId === sagaId) state.connector = { status: 'AVAILABLE', sagaId: undefined };
    },
    async activateReservation() {
      state.calls.push('activate');
      state.connector.status = 'CHARGING';
    },
    async completeReservation() {
      state.connector = { status: 'AVAILABLE', sagaId: undefined };
    },
    async charge({ sagaId, amount }) {
      state.calls.push('charge');
      if (state.charges.has(sagaId)) return;
      if (state.balance < amount) throw new ServiceError('billing', 402, 'INSUFFICIENT_FUNDS', 'sin saldo');
      state.balance -= amount;
      state.charges.set(sagaId, amount);
    },
    async refund({ sagaId }) {
      state.calls.push('refund');
      if (state.failRefundTimes > 0) {
        state.failRefundTimes--;
        throw new ServiceError('billing', 503, 'SERVICE_UNREACHABLE', 'timeout');
      }
      if (!state.charges.has(sagaId) || state.refunds.has(sagaId)) return; // idempotente / no-op
      state.balance += state.charges.get(sagaId)!;
      state.refunds.add(sagaId);
    },
    async startCharging({ sagaId }) {
      state.calls.push('dispatch');
      if (state.hardwareFault) {
        state.sessions.set(sagaId, 'FAILED');
        throw new ServiceError('dispatch', 502, 'HARDWARE_FAULT', 'GROUND_FAULT_DETECTED');
      }
      state.sessions.set(sagaId, 'ACTIVE');
    },
    async stopCharging(sagaId) {
      state.calls.push('stop');
      if (state.sessions.get(sagaId) === 'ACTIVE') state.sessions.set(sagaId, 'STOPPED');
    },
  };
  return { state, participants };
}

const input = { fleetId: 'fleet-rappi', stationId: 'bog-norte', connectorId: 'c1', energyKwh: 20 };

describe('SagaOrchestrator', () => {
  let world: ReturnType<typeof fakeWorld>;
  let store: InMemorySagaStore;
  let flags: Record<string, boolean>;
  let saga: SagaOrchestrator;

  beforeEach(() => {
    world = fakeWorld();
    store = new InMemorySagaStore();
    flags = { [FLAGS.ENABLE_FAST_CHARGE_BOOST]: true };
    saga = new SagaOrchestrator(store, world.participants, { isEnabled: async (n) => flags[n] ?? false }, new Logger('test'), 'test', {
      retryBaseDelayMs: 1,
    });
  });

  it('camino feliz: reserva, cobra, activa y deja el conector en CHARGING', async () => {
    const result = await saga.reserveAndCharge(input);
    expect(result.status).toBe('COMPLETED');
    expect(world.state.calls).toEqual(['reserve', 'charge', 'dispatch', 'activate']);
    expect(world.state.balance).toBe(100_000 - 30_000);
    expect(world.state.connector.status).toBe('CHARGING');
    expect(result.steps.map((s) => s.name)).toEqual(['QUOTE', 'RESERVE', 'CHARGE', 'DISPATCH', 'ACTIVATE']);
  });

  it('falla de hardware en el paso 3: reembolsa y luego libera el conector', async () => {
    world.state.hardwareFault = true;
    const result = await saga.reserveAndCharge(input);
    expect(result.status).toBe('COMPENSATED');
    expect(result.failedStep).toBe('DISPATCH');
    // Orden inverso: billing (refund) antes que reservation (release)
    expect(world.state.calls).toEqual(['reserve', 'charge', 'dispatch', 'stop', 'refund', 'release']);
    expect(world.state.balance).toBe(100_000);
    expect(world.state.connector.status).toBe('AVAILABLE');
    expect(result.steps.filter((s) => s.name.startsWith('COMPENSATE')).map((s) => s.name)).toEqual([
      'COMPENSATE_DISPATCH',
      'COMPENSATE_CHARGE',
      'COMPENSATE_RESERVE',
    ]);
  });

  it('fondos insuficientes en el paso 2: libera el conector inmediatamente', async () => {
    world.state.balance = 1_000;
    const result = await saga.reserveAndCharge(input);
    expect(result.status).toBe('COMPENSATED');
    expect(result.failedStep).toBe('CHARGE');
    expect(world.state.calls).toEqual(['reserve', 'charge', 'refund', 'release']);
    expect(world.state.balance).toBe(1_000); // el refund fue no-op: no había cobro
    expect(world.state.connector.status).toBe('AVAILABLE');
  });

  it('conector ocupado en el paso 1: FAILED sin compensaciones', async () => {
    world.state.connector = { status: 'CHARGING', sagaId: 'otra' };
    const result = await saga.reserveAndCharge(input);
    expect(result.status).toBe('FAILED');
    expect(world.state.calls).toEqual(['reserve']);
  });

  it('flag ENABLE_FAST_CHARGE_BOOST apagada: rechaza reservas prioritarias sin tocar servicios', async () => {
    flags[FLAGS.ENABLE_FAST_CHARGE_BOOST] = false;
    const result = await saga.reserveAndCharge({ ...input, fastChargeBoost: true });
    expect(result.status).toBe('REJECTED');
    expect(world.state.calls).toEqual([]);
  });

  it('idempotencia: misma idempotencyKey no ejecuta la SAGA dos veces', async () => {
    const a = await saga.reserveAndCharge({ ...input, idempotencyKey: 'abc' });
    const b = await saga.reserveAndCharge({ ...input, idempotencyKey: 'abc' });
    expect(b.sagaId).toBe(a.sagaId);
    expect(world.state.calls.filter((c) => c === 'charge')).toHaveLength(1);
    expect(world.state.balance).toBe(70_000);
  });

  it('reintenta compensaciones con backoff ante fallos transitorios', async () => {
    world.state.hardwareFault = true;
    world.state.failRefundTimes = 2;
    const result = await saga.reserveAndCharge(input);
    expect(result.status).toBe('COMPENSATED');
    expect(world.state.calls.filter((c) => c === 'refund')).toHaveLength(3);
    expect(world.state.balance).toBe(100_000);
  });

  it('compensación fallida queda en COMPENSATION_FAILED y se puede reintentar sin doble reembolso', async () => {
    world.state.hardwareFault = true;
    world.state.failRefundTimes = 10;
    const failed = await saga.reserveAndCharge(input);
    expect(failed.status).toBe('COMPENSATION_FAILED');
    expect(world.state.connector.status).toBe('RESERVED');

    world.state.failRefundTimes = 0;
    const retried = await saga.retryCompensation(failed.sagaId);
    expect(retried.status).toBe('COMPENSATED');
    expect(world.state.balance).toBe(100_000);
    expect(world.state.connector.status).toBe('AVAILABLE');

    // Procesar la compensación otra vez (mensaje duplicado) no reembolsa dos veces
    await world.participants.refund({ sagaId: failed.sagaId, fleetId: input.fleetId, reason: 'dup' }, failed.sagaId);
    expect(world.state.balance).toBe(100_000);
  });
});
