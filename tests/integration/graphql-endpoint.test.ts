import { describe, expect, it } from 'vitest';
import { gql } from '../helpers.ts';

/** Requiere los servicios corriendo (scripts/run-local.sh test o el job de CI). */
describe('endpoint GraphQL', () => {
  it('reporta el ambiente y la salud de los tres microservicios', async () => {
    const { data, errors } = await gql(`{ environment { environment services { name status } } }`);
    expect(errors).toBeUndefined();
    expect(data.environment.environment).toBe(process.env.AEGIS_ENV);
    expect(data.environment.services.every((s: { status: string }) => s.status === 'UP')).toBe(true);
  });

  it('agrega estaciones y flags desde servicios distintos en una sola consulta', async () => {
    const { data, errors } = await gql(`{ stations { stationId availableConnectors connectors { status } } featureFlags { name enabled environment } }`);
    expect(errors).toBeUndefined();
    expect(Array.isArray(data.stations)).toBe(true);
    expect(data.featureFlags.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining(['ENABLE_DYNAMIC_SURGE_PRICING', 'ENABLE_FAST_CHARGE_BOOST', 'SIMULATE_CHARGER_HARDWARE_FAULT']),
    );
    expect(new Set(data.featureFlags.map((f: { environment: string }) => f.environment))).toEqual(new Set([process.env.AEGIS_ENV]));
  });

  it('valida la entrada de la mutación', async () => {
    const { errors } = await gql(`mutation { reserveAndCharge(input: { fleetId: "x", stationId: "y", connectorId: "z", energyKwh: -1 }) { sagaId } }`);
    expect(errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });
});
