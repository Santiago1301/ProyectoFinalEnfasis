import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FeatureFlagClient } from '@aegisvolt/shared';
import { cleanupFixtures, createConnector, createWallet, gql } from '../helpers.ts';

/**
 * E2E: ejercita el flujo completo cliente -> GraphQL -> 3 microservicios ->
 * DynamoDB, tal como lo dispara la UI. Requiere el stack corriendo
 * (GRAPHQL_URL, por defecto http://localhost:4000/graphql).
 */
const SAGA = `sagaId status amount failedStep failureReason steps { name status }`;
const FLAG_PROPAGATION_MS = Number(process.env.FLAG_PROPAGATION_MS ?? 3500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reserve(input: Record<string, unknown>) {
  const res = await gql(`mutation($input: ReserveAndChargeInput!) { reserveAndCharge(input: $input) { ${SAGA} } }`, { input });
  expect(res.errors).toBeUndefined();
  return res.data.reserveAndCharge;
}

async function connectorStatus(stationId: string) {
  const res = await gql(`query($id: ID!) { station(stationId: $id) { connectors { status } } }`, { id: stationId });
  return res.data.station.connectors[0].status as string;
}

async function balance(fleetId: string) {
  const res = await gql(`query($id: ID!) { wallet(fleetId: $id) { balance } }`, { id: fleetId });
  return res.data.wallet.balance as number;
}

/**
 * Cambia la flag directamente en la tabla del ambiente, como lo haría un
 * operador. No usa la mutación setFeatureFlag porque en prod está bloqueada
 * (ALLOW_FLAG_MUTATIONS=false) y el PR test -> prod corre el E2E con AEGIS_ENV=prod.
 */
async function setFlag(name: string, enabled: boolean) {
  await new FeatureFlagClient().set(name, enabled, 'e2e');
  await sleep(FLAG_PROPAGATION_MS); // caché de flags en los servicios
}

describe('SAGA Reservar y Activar Carga (E2E vía GraphQL)', () => {
  let initialFault = false;
  beforeAll(async () => {
    const res = await gql(`{ featureFlags { name enabled } }`);
    initialFault = res.data.featureFlags.find((f: { name: string }) => f.name === 'SIMULATE_CHARGER_HARDWARE_FAULT')?.enabled ?? false;
    if (initialFault) await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', false);
  });
  afterAll(async () => {
    if (initialFault) await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', true);
    await cleanupFixtures();
  });

  it('camino feliz: COMPLETED, conector CHARGING, cobro aplicado y liberación al finalizar', async () => {
    const { stationId, connectorId } = await createConnector({ powerKw: 50, ultraFast: false });
    const fleetId = await createWallet(500_000);
    const saga = await reserve({ fleetId, stationId, connectorId, energyKwh: 10 });
    expect(saga.status).toBe('COMPLETED');
    expect(saga.steps.map((s: { name: string }) => s.name)).toEqual(['QUOTE', 'RESERVE', 'CHARGE', 'DISPATCH', 'ACTIVATE']);
    expect(await connectorStatus(stationId)).toBe('CHARGING');
    expect(await balance(fleetId)).toBe(500_000 - saga.amount);

    const stop = await gql(`mutation($id: ID!) { stopCharging(sagaId: $id) { status } }`, { id: saga.sagaId });
    expect(stop.errors).toBeUndefined();
    expect(await connectorStatus(stationId)).toBe('AVAILABLE');
  });

  it('paso 2 falla (fondos insuficientes): compensa liberando el conector', async () => {
    const { stationId, connectorId } = await createConnector({ powerKw: 50, ultraFast: false });
    const fleetId = await createWallet(100);
    const saga = await reserve({ fleetId, stationId, connectorId, energyKwh: 10 });
    expect(saga).toMatchObject({ status: 'COMPENSATED', failedStep: 'CHARGE' });
    expect(saga.failureReason).toContain('INSUFFICIENT_FUNDS');
    expect(await connectorStatus(stationId)).toBe('AVAILABLE');
    expect(await balance(fleetId)).toBe(100);
  });

  it('paso 3 falla (SIMULATE_CHARGER_HARDWARE_FAULT): reembolsa y luego libera el conector', async () => {
    const { stationId, connectorId } = await createConnector({ powerKw: 50, ultraFast: false });
    const fleetId = await createWallet(500_000);
    await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', true);
    try {
      const saga = await reserve({ fleetId, stationId, connectorId, energyKwh: 10 });
      expect(saga).toMatchObject({ status: 'COMPENSATED', failedStep: 'DISPATCH' });
      const comp = saga.steps.filter((s: { name: string }) => s.name.startsWith('COMPENSATE')).map((s: { name: string }) => s.name);
      expect(comp).toEqual(['COMPENSATE_DISPATCH', 'COMPENSATE_CHARGE', 'COMPENSATE_RESERVE']);
      expect(await balance(fleetId)).toBe(500_000);
      expect(await connectorStatus(stationId)).toBe('AVAILABLE');
    } finally {
      await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', false);
    }
  });

  it('idempotencyKey repetida devuelve la misma SAGA y cobra una sola vez', async () => {
    const { stationId, connectorId } = await createConnector({ powerKw: 50, ultraFast: false });
    const fleetId = await createWallet(500_000);
    const key = randomUUID();
    const a = await reserve({ fleetId, stationId, connectorId, energyKwh: 10, idempotencyKey: key });
    const b = await reserve({ fleetId, stationId, connectorId, energyKwh: 10, idempotencyKey: key });
    expect(b.sagaId).toBe(a.sagaId);
    expect(await balance(fleetId)).toBe(500_000 - a.amount);
    await gql(`mutation($id: ID!) { stopCharging(sagaId: $id) { status } }`, { id: a.sagaId });
  });

  it('reserva prioritaria en un conector que no es de ultra-carga queda REJECTED sin tocar servicios', async () => {
    const { stationId, connectorId } = await createConnector({ powerKw: 50, ultraFast: false });
    const fleetId = await createWallet(500_000);
    const saga = await reserve({ fleetId, stationId, connectorId, energyKwh: 10, fastChargeBoost: true });
    expect(saga.status).toBe('REJECTED');
    expect(await connectorStatus(stationId)).toBe('AVAILABLE');
    expect(await balance(fleetId)).toBe(500_000);
  });
});
