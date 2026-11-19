import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { HttpError, dynamo, isTransactionCanceled, tableName } from '@aegisvolt/shared';

export type ConnectorStatus = 'AVAILABLE' | 'RESERVED' | 'CHARGING' | 'FAULTED';
export type ReservationStatus = 'RESERVED' | 'ACTIVE' | 'RELEASED' | 'COMPLETED';

export interface Connector {
  stationId: string;
  connectorId: string;
  status: ConnectorStatus;
  powerKw: number;
  plugType: string;
  ultraFast: boolean;
  reservationSagaId?: string;
  updatedAt?: string;
}

export interface Station {
  stationId: string;
  name: string;
  city: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  connectors: Connector[];
}

export interface Reservation {
  sagaId: string;
  stationId: string;
  connectorId: string;
  fleetId: string;
  priority: boolean;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
  releaseReason?: string;
}

const stationPk = (id: string) => `STATION#${id}`;
const connectorSk = (id: string) => `CONNECTOR#${id}`;
const reservationPk = (sagaId: string) => `RESERVATION#${sagaId}`;

/**
 * Tabla aegisvolt-reservations-<env> (single-table):
 *   pk=STATION#<id>      sk=META              -> datos de la electrolinera
 *   pk=STATION#<id>      sk=CONNECTOR#<id>    -> estado del conector
 *   pk=RESERVATION#<saga> sk=RESERVATION       -> reserva (registro de idempotencia)
 */
export class ReservationRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient = dynamo(),
    private readonly table = tableName('reservations'),
  ) {}

  async listStations(): Promise<Station[]> {
    const items: Record<string, any>[] = [];
    let ExclusiveStartKey: Record<string, any> | undefined;
    do {
      const page = await this.db.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: 'begins_with(pk, :p)',
          ExpressionAttributeValues: { ':p': 'STATION#' },
          ExclusiveStartKey,
        }),
      );
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const stations = new Map<string, Station>();
    const ensure = (id: string) => {
      if (!stations.has(id)) stations.set(id, { stationId: id, name: id, city: '', connectors: [] });
      return stations.get(id)!;
    };
    for (const item of items) {
      const id = String(item.pk).slice('STATION#'.length);
      const station = ensure(id);
      if (item.sk === 'META') {
        Object.assign(station, {
          name: item.name,
          city: item.city,
          address: item.address,
          latitude: num(item.latitude),
          longitude: num(item.longitude),
        });
      } else if (String(item.sk).startsWith('CONNECTOR#')) {
        station.connectors.push(toConnector(item));
      }
    }
    for (const s of stations.values()) s.connectors.sort((a, b) => a.connectorId.localeCompare(b.connectorId));
    return [...stations.values()].sort((a, b) => a.stationId.localeCompare(b.stationId));
  }

  async getConnector(stationId: string, connectorId: string): Promise<Connector | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { pk: stationPk(stationId), sk: connectorSk(connectorId) } }),
    );
    return res.Item ? toConnector(res.Item) : undefined;
  }

  async getReservation(sagaId: string): Promise<Reservation | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { pk: reservationPk(sagaId), sk: 'RESERVATION' }, ConsistentRead: true }),
    );
    return res.Item as Reservation | undefined;
  }

  /**
   * Paso 1 de la SAGA. Escritura transaccional *local al servicio*:
   * conector AVAILABLE -> RESERVED + registro de reserva. Idempotente: si la
   * reserva de esta SAGA ya existe, devuelve la existente.
   */
  async reserve(input: { sagaId: string; stationId: string; connectorId: string; fleetId: string; priority: boolean }) {
    const existing = await this.getReservation(input.sagaId);
    if (existing) return { reservation: existing, idempotent: true };

    const connector = await this.getConnector(input.stationId, input.connectorId);
    if (!connector) throw new HttpError(404, 'CONNECTOR_NOT_FOUND', `Conector ${input.stationId}/${input.connectorId} no existe`);
    if (input.priority && !connector.ultraFast) {
      throw new HttpError(422, 'CONNECTOR_NOT_ULTRA_FAST', 'La reserva prioritaria solo aplica a conectores de ultra-carga');
    }

    const now = new Date().toISOString();
    const reservation: Reservation = { ...input, status: 'RESERVED', createdAt: now, updatedAt: now };
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { pk: stationPk(input.stationId), sk: connectorSk(input.connectorId) },
                UpdateExpression: 'SET #s = :reserved, reservationSagaId = :saga, updatedAt = :now',
                ConditionExpression: '#s = :available',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':reserved': 'RESERVED', ':available': 'AVAILABLE', ':saga': input.sagaId, ':now': now },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { pk: reservationPk(input.sagaId), sk: 'RESERVATION', ...reservation },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (!isTransactionCanceled(err)) throw err;
      const [connectorReason, reservationReason] = err.CancellationReasons ?? [];
      if (reservationReason?.Code === 'ConditionalCheckFailed') {
        // Carrera con un reintento de la misma SAGA: ya quedó reservado.
        return { reservation: (await this.getReservation(input.sagaId))!, idempotent: true };
      }
      if (connectorReason?.Code === 'ConditionalCheckFailed') {
        const current = await this.getConnector(input.stationId, input.connectorId);
        throw new HttpError(409, 'CONNECTOR_NOT_AVAILABLE', `El conector está en estado ${current?.status}`, {
          connectorStatus: current?.status,
        });
      }
      throw err;
    }
    return { reservation, idempotent: false };
  }

  /**
   * Compensación del paso 1: libera el conector (-> AVAILABLE). Idempotente:
   * si la reserva ya fue liberada o nunca existió, no hace nada.
   */
  async release(sagaId: string, reason: string) {
    const reservation = await this.getReservation(sagaId);
    if (!reservation) return { released: false, idempotent: true, note: 'NO_RESERVATION' };
    if (reservation.status === 'RELEASED') return { released: true, idempotent: true, reservation };

    const now = new Date().toISOString();
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { pk: stationPk(reservation.stationId), sk: connectorSk(reservation.connectorId) },
                UpdateExpression: 'SET #s = :available, updatedAt = :now REMOVE reservationSagaId',
                ConditionExpression: 'reservationSagaId = :saga',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':available': 'AVAILABLE', ':saga': sagaId, ':now': now },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { pk: reservationPk(sagaId), sk: 'RESERVATION' },
                UpdateExpression: 'SET #s = :released, releaseReason = :reason, updatedAt = :now',
                ConditionExpression: '#s <> :released',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':released': 'RELEASED', ':reason': reason, ':now': now },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (!isTransactionCanceled(err)) throw err;
      // Otra réplica/reintento ya compensó: el resultado final es el mismo.
      return { released: true, idempotent: true, reservation: await this.getReservation(sagaId) };
    }
    return { released: true, idempotent: false, reservation: { ...reservation, status: 'RELEASED', releaseReason: reason } };
  }

  /** Transición tras la SAGA exitosa (RESERVED -> CHARGING) o al finalizar la carga (-> AVAILABLE). */
  async transition(sagaId: string, to: 'ACTIVE' | 'COMPLETED') {
    const reservation = await this.getReservation(sagaId);
    if (!reservation) throw new HttpError(404, 'RESERVATION_NOT_FOUND', `No existe reserva para la SAGA ${sagaId}`);
    if (reservation.status === to) return { reservation, idempotent: true };
    const from = to === 'ACTIVE' ? 'RESERVED' : 'ACTIVE';
    if (reservation.status !== from) {
      throw new HttpError(409, 'INVALID_RESERVATION_STATE', `La reserva está en ${reservation.status}, se esperaba ${from}`);
    }
    const connectorStatus: ConnectorStatus = to === 'ACTIVE' ? 'CHARGING' : 'AVAILABLE';
    const now = new Date().toISOString();
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.table,
              Key: { pk: stationPk(reservation.stationId), sk: connectorSk(reservation.connectorId) },
              UpdateExpression:
                to === 'ACTIVE' ? 'SET #s = :cs, updatedAt = :now' : 'SET #s = :cs, updatedAt = :now REMOVE reservationSagaId',
              ConditionExpression: 'reservationSagaId = :saga',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':cs': connectorStatus, ':saga': sagaId, ':now': now },
            },
          },
          {
            Update: {
              TableName: this.table,
              Key: { pk: reservationPk(sagaId), sk: 'RESERVATION' },
              UpdateExpression: 'SET #s = :to, updatedAt = :now',
              ConditionExpression: '#s = :from',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':to': to, ':from': from, ':now': now },
            },
          },
        ],
      }),
    );
    return { reservation: { ...reservation, status: to, updatedAt: now }, idempotent: false };
  }
}

function num(v: unknown): number | undefined {
  return v === undefined || v === null ? undefined : Number(v);
}

function toConnector(item: Record<string, any>): Connector {
  return {
    stationId: String(item.pk).slice('STATION#'.length),
    connectorId: String(item.sk).slice('CONNECTOR#'.length),
    status: item.status,
    powerKw: Number(item.powerKw),
    plugType: item.plugType,
    ultraFast: item.ultraFast === true || item.ultraFast === 'true',
    reservationSagaId: item.reservationSagaId,
    updatedAt: item.updatedAt,
  };
}
