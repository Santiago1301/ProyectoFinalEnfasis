import { GraphQLError } from 'graphql';
import type { FeatureFlagClient, Logger } from '@aegisvolt/shared';
import { ServiceError, type ServiceClients } from './clients.ts';
import type { SagaOrchestrator } from './saga/orchestrator.ts';
import type { SagaStore } from './saga/store.ts';
import type { ReserveAndChargeInput } from './saga/types.ts';

export interface GatewayDeps {
  clients: ServiceClients;
  orchestrator: SagaOrchestrator;
  store: SagaStore;
  flags: FeatureFlagClient;
  logger: Logger;
  environment: string;
  flagMutationsAllowed: boolean;
}

type Station = { stationId: string; connectors: { status: string }[] };

const toGraphQLError = (err: unknown) => {
  if (err instanceof GraphQLError) return err;
  if (err instanceof ServiceError) {
    return new GraphQLError(err.message, { extensions: { code: err.code, service: err.service, httpStatus: err.status } });
  }
  return new GraphQLError((err as Error).message, { extensions: { code: 'BAD_REQUEST' } });
};

const safe =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      throw toGraphQLError(err);
    }
  };

/** Genera valores sólo cuando cambian, consultando cada `intervalMs`. */
async function* poll<T>(fetcher: () => Promise<T>, intervalMs = 2000): AsyncGenerator<T> {
  let last = '';
  while (true) {
    const value = await fetcher();
    const serialized = JSON.stringify(value);
    if (serialized !== last) {
      last = serialized;
      yield value;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function buildResolvers(d: GatewayDeps) {
  const { clients } = d;
  const stations = () => clients.reservation.get<Station[]>('/stations');
  const getSession = async (sagaId: string) => {
    try {
      return await clients.dispatch.get(`/sessions/${sagaId}`);
    } catch (err) {
      if (err instanceof ServiceError && err.status === 404) return null;
      throw err;
    }
  };

  return {
    Query: {
      environment: safe(async () => ({
        environment: d.environment,
        version: process.env.APP_VERSION ?? 'local',
        flagMutationsAllowed: d.flagMutationsAllowed,
        services: [
          { name: 'graphql-gateway', status: 'UP', version: process.env.APP_VERSION ?? 'local', track: process.env.DEPLOY_TRACK ?? 'stable', latencyMs: 0 },
          ...(await Promise.all([clients.reservation.health(), clients.billing.health(), clients.dispatch.health()])),
        ],
      })),
      stations: safe(stations),
      station: safe(async (_: unknown, { stationId }: { stationId: string }) => {
        try {
          return await clients.reservation.get(`/stations/${encodeURIComponent(stationId)}`);
        } catch (err) {
          if (err instanceof ServiceError && err.status === 404) return null;
          throw err;
        }
      }),
      wallets: safe(() => clients.billing.get('/wallets')),
      wallet: safe(async (_: unknown, { fleetId }: { fleetId: string }) => {
        try {
          return await clients.billing.get(`/wallets/${encodeURIComponent(fleetId)}`);
        } catch (err) {
          if (err instanceof ServiceError && err.status === 404) return null;
          throw err;
        }
      }),
      featureFlags: safe(() => d.flags.list()),
      quote: safe(async (_: unknown, { input }: { input: { stationId: string; connectorId: string; energyKwh: number; fastChargeBoost?: boolean } }) => {
        const station = await clients.reservation.get<{ connectors: { connectorId: string; powerKw: number }[] }>(
          `/stations/${encodeURIComponent(input.stationId)}`,
        );
        const connector = station.connectors.find((c) => c.connectorId === input.connectorId);
        if (!connector) throw new GraphQLError('Conector no encontrado', { extensions: { code: 'NOT_FOUND' } });
        return clients.billing.post('/quotes', { powerKw: connector.powerKw, energyKwh: input.energyKwh, priority: input.fastChargeBoost });
      }),
      sagas: safe((_: unknown, { limit }: { limit: number }) => d.store.list(Math.min(limit ?? 25, 200))),
      saga: safe((_: unknown, { sagaId }: { sagaId: string }) => d.store.get(sagaId)),
      chargingSessions: safe(() => clients.dispatch.get('/sessions')),
      chargingSession: safe((_: unknown, { sagaId }: { sagaId: string }) => getSession(sagaId)),
    },

    Mutation: {
      reserveAndCharge: safe((_: unknown, { input }: { input: ReserveAndChargeInput }) => {
        if (!(input.energyKwh > 0 && input.energyKwh <= 500)) {
          throw new GraphQLError('energyKwh debe estar entre 0 y 500', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        return d.orchestrator.reserveAndCharge(input);
      }),
      stopCharging: safe((_: unknown, { sagaId }: { sagaId: string }) => d.orchestrator.stopCharging(sagaId)),
      retrySagaCompensation: safe((_: unknown, { sagaId }: { sagaId: string }) => d.orchestrator.retryCompensation(sagaId)),
      setFeatureFlag: safe(async (_: unknown, { name, enabled }: { name: string; enabled: boolean }) => {
        if (!d.flagMutationsAllowed) {
          throw new GraphQLError(`Cambiar flags vía API está deshabilitado en ${d.environment}`, { extensions: { code: 'FORBIDDEN' } });
        }
        const flag = await d.flags.set(name, enabled, 'graphql-ui');
        d.logger.warn('feature_flag_changed', { flag: name, enabled });
        return flag;
      }),
    },

    Subscription: {
      stationsUpdated: { subscribe: () => poll(stations), resolve: (v: unknown) => v },
      sagaUpdated: {
        subscribe: (_: unknown, { sagaId }: { sagaId: string }) => poll(() => d.store.get(sagaId), 1000),
        resolve: (v: unknown) => v,
      },
      featureFlagsUpdated: { subscribe: () => poll(() => d.flags.list(), 2000), resolve: (v: unknown) => v },
    },

    Station: {
      availableConnectors: (s: Station) => s.connectors.filter((c) => c.status === 'AVAILABLE').length,
    },
    Wallet: {
      transactions: safe((w: { fleetId: string }, { limit }: { limit: number }) =>
        clients.billing.get(`/wallets/${encodeURIComponent(w.fleetId)}/transactions?limit=${limit ?? 20}`),
      ),
    },
    Saga: {
      session: safe((s: { sagaId: string }) => getSession(s.sagaId)),
    },
    ChargingSession: {
      telemetry: safe((s: { sagaId: string }, { limit }: { limit: number }) =>
        clients.dispatch.get(`/sessions/${s.sagaId}/telemetry?limit=${limit ?? 30}`),
      ),
    },
  };
}
