import { ServiceError, type ServiceClients } from '../clients.ts';
import type { SagaParticipants } from './types.ts';

/** Implementación HTTP del puerto SagaParticipants contra los microservicios. */
export function httpParticipants(c: ServiceClients): SagaParticipants {
  return {
    async getConnector(stationId, connectorId, cid) {
      try {
        const station = await c.reservation.get<{ connectors: { connectorId: string; powerKw: number; ultraFast: boolean; status: string }[] }>(
          `/stations/${encodeURIComponent(stationId)}`,
          cid,
        );
        return station.connectors.find((x) => x.connectorId === connectorId);
      } catch (err) {
        if (err instanceof ServiceError && err.status === 404) return undefined;
        throw err;
      }
    },
    quote: (input, cid) => c.billing.post('/quotes', input, cid),
    reserve: async (input, cid) => void (await c.reservation.post('/reservations', input, cid)),
    releaseReservation: async (sagaId, reason, cid) =>
      void (await c.reservation.post(`/reservations/${sagaId}/release`, { reason }, cid)),
    activateReservation: async (sagaId, cid) => void (await c.reservation.post(`/reservations/${sagaId}/activate`, {}, cid)),
    completeReservation: async (sagaId, cid) => void (await c.reservation.post(`/reservations/${sagaId}/complete`, {}, cid)),
    charge: async (input, cid) => void (await c.billing.post('/charges', input, cid)),
    refund: async (input, cid) =>
      void (await c.billing.post(`/charges/${input.sagaId}/refund`, { fleetId: input.fleetId, reason: input.reason }, cid)),
    startCharging: async (input, cid) => void (await c.dispatch.post('/sessions', input, cid)),
    stopCharging: async (sagaId, cid) => void (await c.dispatch.post(`/sessions/${sagaId}/stop`, {}, cid)),
  };
}
