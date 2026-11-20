import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { dynamo, tableName } from '@aegisvolt/shared';

/**
 * Las pruebas de integración/E2E corren contra las tablas reales del ambiente
 * AEGIS_ENV (por defecto `test`) en Floci o AWS. Cada prueba crea sus propios
 * datos con ids únicos (it-<uuid>) para no depender de la semilla ni chocar
 * con otras ejecuciones, y los borra al terminar.
 */
process.env.AEGIS_ENV ??= 'test';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= 'us-east-1';

export const uid = (p = 'it') => `${p}-${randomUUID().slice(0, 8)}`;

const cleanup: { table: string; key: Record<string, string> }[] = [];

async function put(table: string, item: Record<string, unknown>, key: Record<string, string>) {
  await dynamo().send(new PutCommand({ TableName: table, Item: item }));
  cleanup.push({ table, key });
}

export async function createConnector(opts: { powerKw?: number; ultraFast?: boolean; status?: string } = {}) {
  const stationId = uid('it-station');
  const connectorId = 'c1';
  const table = tableName('reservations');
  await put(table, { pk: `STATION#${stationId}`, sk: 'META', name: `Estación ${stationId}`, city: 'Test' }, { pk: `STATION#${stationId}`, sk: 'META' });
  await put(
    table,
    {
      pk: `STATION#${stationId}`,
      sk: `CONNECTOR#${connectorId}`,
      status: opts.status ?? 'AVAILABLE',
      powerKw: opts.powerKw ?? 150,
      plugType: 'CCS2',
      ultraFast: opts.ultraFast ?? true,
    },
    { pk: `STATION#${stationId}`, sk: `CONNECTOR#${connectorId}` },
  );
  return { stationId, connectorId };
}

export async function createWallet(balance: number) {
  const fleetId = uid('it-fleet');
  await put(
    tableName('billing'),
    { pk: `WALLET#${fleetId}`, sk: 'PROFILE', fleetName: `Flota ${fleetId}`, balance, currency: 'COP' },
    { pk: `WALLET#${fleetId}`, sk: 'PROFILE' },
  );
  return fleetId;
}

export async function cleanupFixtures() {
  for (const { table, key } of cleanup.splice(0)) {
    await dynamo().send(new DeleteCommand({ TableName: table, Key: key })).catch(() => undefined);
  }
}

export const GRAPHQL_URL = process.env.GRAPHQL_URL ?? 'http://localhost:4000/graphql';

export async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<{ data?: T; errors?: { message: string; extensions?: { code?: string } }[] }> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
