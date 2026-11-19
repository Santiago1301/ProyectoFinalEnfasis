import { GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dynamo } from './dynamo.ts';
import { getEnvironment, tableName } from './config.ts';

export const FLAGS = {
  ENABLE_DYNAMIC_SURGE_PRICING: 'ENABLE_DYNAMIC_SURGE_PRICING',
  ENABLE_FAST_CHARGE_BOOST: 'ENABLE_FAST_CHARGE_BOOST',
  SIMULATE_CHARGER_HARDWARE_FAULT: 'SIMULATE_CHARGER_HARDWARE_FAULT',
} as const;
export type FlagName = (typeof FLAGS)[keyof typeof FLAGS];

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description?: string;
  environment: string;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Feature flags propias sobre DynamoDB. Cada ambiente tiene su propia tabla
 * (aegisvolt-feature-flags-<env>), así que cambiar una flag en dev nunca
 * afecta a prod. Las lecturas se cachean pocos segundos (FLAG_CACHE_TTL_MS)
 * para que un cambio se refleje sin redesplegar ni reiniciar pods.
 */
export class FeatureFlagClient {
  private cache = new Map<string, { value: FeatureFlag | undefined; expires: number }>();

  constructor(
    private readonly table = tableName('feature-flags'),
    private readonly ttlMs = Number(process.env.FLAG_CACHE_TTL_MS ?? 3000),
    private readonly db: DynamoDBDocumentClient = dynamo(),
  ) {}

  async isEnabled(name: FlagName | string): Promise<boolean> {
    return (await this.get(name))?.enabled ?? false;
  }

  async get(name: string): Promise<FeatureFlag | undefined> {
    const hit = this.cache.get(name);
    if (hit && hit.expires > Date.now()) return hit.value;
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: { name } }));
    const value = res.Item ? toFlag(res.Item) : undefined;
    this.cache.set(name, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  async list(): Promise<FeatureFlag[]> {
    const res = await this.db.send(new ScanCommand({ TableName: this.table }));
    return (res.Items ?? []).map(toFlag).sort((a, b) => a.name.localeCompare(b.name));
  }

  async set(name: string, enabled: boolean, updatedBy = 'graphql'): Promise<FeatureFlag> {
    const current = await this.db.send(new GetCommand({ TableName: this.table, Key: { name } }));
    const item = {
      ...(current.Item ?? {}),
      name,
      enabled,
      environment: getEnvironment(),
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    await this.db.send(new PutCommand({ TableName: this.table, Item: item }));
    this.cache.delete(name);
    return toFlag(item);
  }
}

function toFlag(item: Record<string, unknown>): FeatureFlag {
  return {
    name: String(item.name),
    enabled: item.enabled === true || item.enabled === 'true',
    description: item.description as string | undefined,
    environment: String(item.environment ?? getEnvironment()),
    updatedAt: item.updatedAt as string | undefined,
    updatedBy: item.updatedBy as string | undefined,
  };
}
