import { afterAll, describe, expect, it } from 'vitest';
import { cleanupFixtures, createWallet, uid } from '../helpers.ts';
import { BillingRepository } from '../../services/billing-wallet-service/src/repository.ts';

describe('billing-wallet-service ↔ DynamoDB', () => {
  const repo = new BillingRepository();
  afterAll(cleanupFixtures);

  it('un cobro repetido con el mismo sagaId sólo descuenta una vez', async () => {
    const fleetId = await createWallet(10_000);
    const sagaId = uid('saga');
    await repo.charge({ sagaId, fleetId, amount: 3_000 });
    const again = await repo.charge({ sagaId, fleetId, amount: 3_000 });
    expect(again.idempotent).toBe(true);
    expect((await repo.getWallet(fleetId))?.balance).toBe(7_000);
  });

  it('rechaza con 402 si el saldo es insuficiente sin modificar la billetera', async () => {
    const fleetId = await createWallet(1_000);
    await expect(repo.charge({ sagaId: uid('saga'), fleetId, amount: 5_000 })).rejects.toMatchObject({
      status: 402,
      code: 'INSUFFICIENT_FUNDS',
    });
    expect((await repo.getWallet(fleetId))?.balance).toBe(1_000);
  });

  it('el reembolso compensatorio es idempotente (procesado dos veces = un reembolso)', async () => {
    const fleetId = await createWallet(10_000);
    const sagaId = uid('saga');
    await repo.charge({ sagaId, fleetId, amount: 4_000 });
    const first = await repo.refund({ sagaId, fleetId, reason: 'TEST' });
    const second = await repo.refund({ sagaId, fleetId, reason: 'TEST' });
    expect(first).toMatchObject({ refunded: true, idempotent: false });
    expect(second).toMatchObject({ refunded: true, idempotent: true });
    expect((await repo.getWallet(fleetId))?.balance).toBe(10_000);
    const txs = await repo.listTransactions(fleetId);
    expect(txs.map((t) => `${t.type}:${t.status}`).sort()).toEqual(['CHARGE:REFUNDED', 'REFUND:SETTLED']);
  });

  it('reembolsar una SAGA que nunca cobró es un no-op', async () => {
    const fleetId = await createWallet(10_000);
    expect(await repo.refund({ sagaId: uid('saga'), fleetId, reason: 'TEST' })).toMatchObject({ refunded: false, note: 'NO_CHARGE' });
    expect((await repo.getWallet(fleetId))?.balance).toBe(10_000);
  });
});
