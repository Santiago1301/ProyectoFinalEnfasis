import { FLAGS, FeatureFlagClient, HttpError, Logger, asyncHandler, createServiceApp } from '@aegisvolt/shared';
import { quote } from './pricing.ts';
import { BillingRepository } from './repository.ts';

export function buildApp(deps: { repo: BillingRepository; flags: FeatureFlagClient; logger: Logger }) {
  const { repo, flags, logger } = deps;
  return createServiceApp(logger, (app) => {
    app.get('/wallets', asyncHandler(async (_req, res) => res.json(await repo.listWallets())));

    app.get(
      '/wallets/:fleetId',
      asyncHandler(async (req, res) => {
        const wallet = await repo.getWallet(String(req.params.fleetId));
        if (!wallet) throw new HttpError(404, 'WALLET_NOT_FOUND', 'Billetera no encontrada');
        res.json(wallet);
      }),
    );

    app.get(
      '/wallets/:fleetId/transactions',
      asyncHandler(async (req, res) =>
        res.json(await repo.listTransactions(String(req.params.fleetId), Number(req.query.limit ?? 50))),
      ),
    );

    app.post(
      '/quotes',
      asyncHandler(async (req, res) => {
        const { powerKw, energyKwh, priority = false } = req.body ?? {};
        try {
          res.json(
            quote({
              powerKw: Number(powerKw),
              energyKwh: Number(energyKwh),
              priority: Boolean(priority),
              surgePricingEnabled: await flags.isEnabled(FLAGS.ENABLE_DYNAMIC_SURGE_PRICING),
            }),
          );
        } catch (err) {
          if (err instanceof RangeError) throw new HttpError(400, 'BAD_REQUEST', err.message);
          throw err;
        }
      }),
    );

    // SAGA paso 2
    app.post(
      '/charges',
      asyncHandler(async (req, res) => {
        const { sagaId, fleetId, amount, reason } = req.body ?? {};
        if (!sagaId || !fleetId) throw new HttpError(400, 'BAD_REQUEST', 'sagaId y fleetId son obligatorios');
        const result = await repo.charge({ sagaId, fleetId, amount: Number(amount), reason });
        req.log.info(result.idempotent ? 'charge_already_settled' : 'wallet_charged', {
          saga_step: 'CHARGE',
          fleet_id: fleetId,
          amount: Number(amount),
        });
        res.status(result.idempotent ? 200 : 201).json(result);
      }),
    );

    // Compensación del paso 2
    app.post(
      '/charges/:sagaId/refund',
      asyncHandler(async (req, res) => {
        const { fleetId, reason = 'SAGA_COMPENSATION' } = req.body ?? {};
        if (!fleetId) throw new HttpError(400, 'BAD_REQUEST', 'fleetId es obligatorio');
        const result = await repo.refund({ sagaId: String(req.params.sagaId), fleetId, reason });
        req.log.warn('wallet_refunded', {
          saga_step: 'COMPENSATE_CHARGE',
          fleet_id: fleetId,
          refunded: result.refunded,
          idempotent: result.idempotent,
          amount: result.transaction?.amount,
        });
        res.json(result);
      }),
    );
  });
}
