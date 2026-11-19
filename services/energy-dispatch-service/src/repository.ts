import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { dynamo, isConditionalCheckFailed, tableName } from '@aegisvolt/shared';

export type SessionStatus = 'ACTIVE' | 'COMPLETED' | 'STOPPED' | 'FAILED';

export interface ChargingSession {
  sagaId: string;
  stationId: string;
  connectorId: string;
  status: SessionStatus;
  powerKw: number;
  energyKwhTarget: number;
  deliveredKwh: number;
  faultCode?: string;
  startedAt: string;
  updatedAt: string;
  lastTickAt?: number;
}

export interface TelemetryPoint {
  timestamp: string;
  powerKw: number;
  voltage: number;
  currentA: number;
  deliveredKwh: number;
  stateOfCharge: number;
}

const sessionPk = (sagaId: string) => `SESSION#${sagaId}`;

/**
 * Tabla aegisvolt-dispatch-<env>:
 *   pk=SESSION#<saga> sk=SESSION            -> orden de activación física
 *   pk=SESSION#<saga> sk=TELEMETRY#<iso>    -> muestras de telemetría
 */
export class DispatchRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient = dynamo(),
    private readonly table = tableName('dispatch'),
  ) {}

  async getSession(sagaId: string): Promise<ChargingSession | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { pk: sessionPk(sagaId), sk: 'SESSION' }, ConsistentRead: true }),
    );
    return res.Item as ChargingSession | undefined;
  }

  async listSessions(status?: SessionStatus): Promise<ChargingSession[]> {
    const res = await this.db.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: status ? 'sk = :s AND #st = :status' : 'sk = :s',
        ExpressionAttributeNames: status ? { '#st': 'status' } : undefined,
        ExpressionAttributeValues: { ':s': 'SESSION', ...(status ? { ':status': status } : {}) },
      }),
    );
    return (res.Items ?? []).map((i) => i as ChargingSession).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Crea la sesión sólo si no existe: la condición es la llave de idempotencia del paso 3. */
  async createSession(session: ChargingSession): Promise<{ session: ChargingSession; created: boolean }> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: sessionPk(session.sagaId), sk: 'SESSION', ...session },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { session, created: true };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      return { session: (await this.getSession(session.sagaId))!, created: false };
    }
  }

  async addTelemetry(sagaId: string, point: TelemetryPoint) {
    await this.db.send(
      new PutCommand({ TableName: this.table, Item: { pk: sessionPk(sagaId), sk: `TELEMETRY#${point.timestamp}`, ...point } }),
    );
  }

  async listTelemetry(sagaId: string, limit = 60): Promise<TelemetryPoint[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :t)',
        ExpressionAttributeValues: { ':pk': sessionPk(sagaId), ':t': 'TELEMETRY#' },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map((i) => i as TelemetryPoint).reverse();
  }

  /**
   * Avanza la energía entregada. La condición sobre lastTickAt evita que
   * varias réplicas (stable + canary) dupliquen el mismo tick.
   */
  async tick(sagaId: string, deliveredKwh: number, status: SessionStatus, now: number, minIntervalMs: number) {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: sessionPk(sagaId), sk: 'SESSION' },
          UpdateExpression: 'SET deliveredKwh = :d, #s = :status, lastTickAt = :now, updatedAt = :iso',
          ConditionExpression: '#s = :active AND (attribute_not_exists(lastTickAt) OR lastTickAt <= :threshold)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':d': deliveredKwh,
            ':status': status,
            ':now': now,
            ':iso': new Date(now).toISOString(),
            ':active': 'ACTIVE',
            ':threshold': now - minIntervalMs,
          },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async stop(sagaId: string): Promise<ChargingSession | undefined> {
    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: sessionPk(sagaId), sk: 'SESSION' },
          UpdateExpression: 'SET #s = :stopped, updatedAt = :iso',
          ConditionExpression: '#s = :active',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':stopped': 'STOPPED', ':active': 'ACTIVE', ':iso': new Date().toISOString() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return res.Attributes as ChargingSession;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return this.getSession(sagaId);
      throw err;
    }
  }
}
