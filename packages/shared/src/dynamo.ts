import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { awsClientConfig } from './config.ts';

let doc: DynamoDBDocumentClient | undefined;

export function dynamo(): DynamoDBDocumentClient {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfig()), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return doc;
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

export function isTransactionCanceled(err: unknown): err is { name: string; CancellationReasons?: { Code?: string }[] } {
  return (err as { name?: string })?.name === 'TransactionCanceledException';
}
