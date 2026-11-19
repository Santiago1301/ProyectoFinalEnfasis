import { GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dynamo, isConditionalCheckFailed, tableName } from '@aegisvolt/shared';
import type { SagaRecord } from './types.ts';

export interface SagaStore {
  create(record: SagaRecord): Promise<boolean>;
  get(sagaId: string): Promise<SagaRecord | undefined>;
  save(record: SagaRecord): Promise<SagaRecord>;
  list(limit: number): Promise<SagaRecord[]>;
}

export class ConcurrentSagaUpdateError extends Error {}

/**
 * Log de estado del orquestador en aegisvolt-sagas-<env>. Cada transición se
 * persiste antes de invocar el siguiente paso; así, si el pod muere a mitad
 * de una SAGA, Prefect detecta la SAGA "huérfana" (estado no terminal viejo)
 * y la compensación puede reanudarse con retrySagaCompensation.
 * Usa bloqueo optimista (atributo `version`).
 */
export class DynamoSagaStore implements SagaStore {
  constructor(
    private readonly db: DynamoDBDocumentClient = dynamo(),
    private readonly table = tableName('sagas'),
  ) {}

  async create(record: SagaRecord): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({ TableName: this.table, Item: record, ConditionExpression: 'attribute_not_exists(sagaId)' }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async get(sagaId: string) {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: { sagaId }, ConsistentRead: true }));
    return res.Item as SagaRecord | undefined;
  }

  async save(record: SagaRecord): Promise<SagaRecord> {
    const next = { ...record, version: record.version + 1, updatedAt: new Date().toISOString() };
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: next,
          ConditionExpression: 'version = :v',
          ExpressionAttributeValues: { ':v': record.version },
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) throw new ConcurrentSagaUpdateError(`SAGA ${record.sagaId} modificada concurrentemente`);
      throw err;
    }
    return next;
  }

  async list(limit: number) {
    const items: SagaRecord[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(new ScanCommand({ TableName: this.table, ExclusiveStartKey }));
      items.push(...((page.Items ?? []) as SagaRecord[]));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}

export class InMemorySagaStore implements SagaStore {
  readonly items = new Map<string, SagaRecord>();
  async create(record: SagaRecord) {
    if (this.items.has(record.sagaId)) return false;
    this.items.set(record.sagaId, structuredClone(record));
    return true;
  }
  async get(sagaId: string) {
    const r = this.items.get(sagaId);
    return r && structuredClone(r);
  }
  async save(record: SagaRecord) {
    const current = this.items.get(record.sagaId);
    if (current && current.version !== record.version) throw new ConcurrentSagaUpdateError(record.sagaId);
    const next = { ...record, version: record.version + 1, updatedAt: new Date().toISOString() };
    this.items.set(record.sagaId, structuredClone(next));
    return next;
  }
  async list(limit: number) {
    return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}
