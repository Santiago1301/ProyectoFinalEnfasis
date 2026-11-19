import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HttpError, dynamo, isTransactionCanceled, tableName } from '@aegisvolt/shared';

export interface Wallet {
  fleetId: string;
  fleetName: string;
  balance: number;
  currency: string;
  updatedAt?: string;
}

export interface WalletTransaction {
  txId: string;
  sagaId: string;
  fleetId: string;
  type: 'CHARGE' | 'REFUND';
  amount: number;
  status: 'SETTLED' | 'REFUNDED';
  reason?: string;
  createdAt: string;
  updatedAt?: string;
}

const walletPk = (fleetId: string) => `WALLET#${fleetId}`;
const txSk = (sagaId: string, type: 'CHARGE' | 'REFUND') => `TX#${sagaId}#${type}`;

/**
 * Tabla aegisvolt-billing-<env>:
 *   pk=WALLET#<fleet> sk=PROFILE               -> saldo de la billetera
 *   pk=WALLET#<fleet> sk=TX#<saga>#CHARGE      -> cobro de la SAGA (clave de idempotencia)
 *   pk=WALLET#<fleet> sk=TX#<saga>#REFUND      -> reembolso compensatorio (clave de idempotencia)
 */
export class BillingRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient = dynamo(),
    private readonly table = tableName('billing'),
  ) {}

  async listWallets(): Promise<Wallet[]> {
    const res = await this.db.send(
      new ScanCommand({ TableName: this.table, FilterExpression: 'sk = :p', ExpressionAttributeValues: { ':p': 'PROFILE' } }),
    );
    return (res.Items ?? []).map(toWallet).sort((a, b) => a.fleetId.localeCompare(b.fleetId));
  }

  async getWallet(fleetId: string): Promise<Wallet | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { pk: walletPk(fleetId), sk: 'PROFILE' }, ConsistentRead: true }),
    );
    return res.Item ? toWallet(res.Item) : undefined;
  }

  async listTransactions(fleetId: string, limit = 50): Promise<WalletTransaction[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tx)',
        ExpressionAttributeValues: { ':pk': walletPk(fleetId), ':tx': 'TX#' },
      }),
    );
    return (res.Items ?? [])
      .map((i) => i as WalletTransaction)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getTransaction(fleetId: string, sagaId: string, type: 'CHARGE' | 'REFUND') {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { pk: walletPk(fleetId), sk: txSk(sagaId, type) }, ConsistentRead: true }),
    );
    return res.Item as WalletTransaction | undefined;
  }

  /**
   * Paso 2 de la SAGA: descuenta el saldo y registra el cobro en una sola
   * transacción local. La condición `attribute_not_exists` sobre el ítem TX
   * hace el cobro idempotente: reintentar la misma SAGA nunca cobra dos veces.
   */
  async charge(input: { sagaId: string; fleetId: string; amount: number; reason?: string }) {
    if (!(input.amount > 0)) throw new HttpError(400, 'BAD_REQUEST', 'amount debe ser mayor a 0');
    const now = new Date().toISOString();
    const tx: WalletTransaction = {
      txId: `${input.sagaId}#CHARGE`,
      sagaId: input.sagaId,
      fleetId: input.fleetId,
      type: 'CHARGE',
      amount: input.amount,
      status: 'SETTLED',
      reason: input.reason ?? 'Reserva y activación de carga',
      createdAt: now,
    };
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { pk: walletPk(input.fleetId), sk: 'PROFILE' },
                UpdateExpression: 'SET balance = balance - :a, updatedAt = :now',
                ConditionExpression: 'attribute_exists(pk) AND balance >= :a',
                ExpressionAttributeValues: { ':a': input.amount, ':now': now },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { pk: walletPk(input.fleetId), sk: txSk(input.sagaId, 'CHARGE'), ...tx },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (!isTransactionCanceled(err)) throw err;
      const [walletReason, txReason] = err.CancellationReasons ?? [];
      if (txReason?.Code === 'ConditionalCheckFailed') {
        return { transaction: (await this.getTransaction(input.fleetId, input.sagaId, 'CHARGE'))!, idempotent: true };
      }
      if (walletReason?.Code === 'ConditionalCheckFailed') {
        const wallet = await this.getWallet(input.fleetId);
        if (!wallet) throw new HttpError(404, 'WALLET_NOT_FOUND', `La flota ${input.fleetId} no tiene billetera`);
        throw new HttpError(402, 'INSUFFICIENT_FUNDS', `Saldo insuficiente: ${wallet.balance} < ${input.amount}`, {
          balance: wallet.balance,
          required: input.amount,
        });
      }
      throw err;
    }
    return { transaction: tx, idempotent: false };
  }

  /**
   * Compensación del paso 2: reembolsa el cobro de la SAGA. Idempotente por
   * el ítem TX#<saga>#REFUND; si nunca hubo cobro, no hace nada.
   */
  async refund(input: { sagaId: string; fleetId: string; reason: string }) {
    const charge = await this.getTransaction(input.fleetId, input.sagaId, 'CHARGE');
    if (!charge) return { refunded: false, idempotent: true, note: 'NO_CHARGE' };
    const existing = await this.getTransaction(input.fleetId, input.sagaId, 'REFUND');
    if (existing) return { refunded: true, idempotent: true, transaction: existing };

    const now = new Date().toISOString();
    const refund: WalletTransaction = {
      txId: `${input.sagaId}#REFUND`,
      sagaId: input.sagaId,
      fleetId: input.fleetId,
      type: 'REFUND',
      amount: charge.amount,
      status: 'SETTLED',
      reason: input.reason,
      createdAt: now,
    };
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { pk: walletPk(input.fleetId), sk: txSk(input.sagaId, 'REFUND'), ...refund },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { pk: walletPk(input.fleetId), sk: 'PROFILE' },
                UpdateExpression: 'SET balance = balance + :a, updatedAt = :now',
                ExpressionAttributeValues: { ':a': charge.amount, ':now': now },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { pk: walletPk(input.fleetId), sk: txSk(input.sagaId, 'CHARGE') },
                UpdateExpression: 'SET #s = :refunded, updatedAt = :now',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':refunded': 'REFUNDED', ':now': now },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (!isTransactionCanceled(err)) throw err;
      return {
        refunded: true,
        idempotent: true,
        transaction: await this.getTransaction(input.fleetId, input.sagaId, 'REFUND'),
      };
    }
    return { refunded: true, idempotent: false, transaction: refund };
  }
}

function toWallet(item: Record<string, any>): Wallet {
  return {
    fleetId: String(item.pk).slice('WALLET#'.length),
    fleetName: item.fleetName,
    balance: Number(item.balance),
    currency: item.currency ?? 'COP',
    updatedAt: item.updatedAt,
  };
}
