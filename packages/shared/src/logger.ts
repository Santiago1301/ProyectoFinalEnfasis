import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { hostname } from 'node:os';
import { awsClientConfig, getEnvironment } from './config.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  correlation_id?: string;
  [key: string]: unknown;
}

/** Envía lotes de eventos al log group `/aegisvolt/<env>/<service>` (creado por Terraform). */
class CloudWatchSink {
  private buffer: { timestamp: number; message: string }[] = [];
  private client = new CloudWatchLogsClient(awsClientConfig());
  private streamReady?: Promise<void>;
  private readonly logStream = `${process.env.HOSTNAME ?? hostname()}-${process.pid}`;

  constructor(private readonly logGroup: string) {
    setInterval(() => void this.flush(), 2000).unref();
  }

  push(message: string) {
    this.buffer.push({ timestamp: Date.now(), message });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const logEvents = this.buffer.splice(0, this.buffer.length);
    try {
      this.streamReady ??= this.client
        .send(new CreateLogStreamCommand({ logGroupName: this.logGroup, logStreamName: this.logStream }))
        .then(() => undefined)
        .catch((err: { name?: string }) => {
          if (err.name !== 'ResourceAlreadyExistsException') throw err;
        });
      await this.streamReady;
      await this.client.send(
        new PutLogEventsCommand({ logGroupName: this.logGroup, logStreamName: this.logStream, logEvents }),
      );
    } catch (err) {
      this.streamReady = undefined;
      process.stderr.write(`[logger] no se pudo enviar a CloudWatch ${this.logGroup}: ${(err as Error).message}\n`);
    }
  }
}

/**
 * Logger estructurado JSON. Cada línea incluye timestamp, level, service,
 * environment, version/track del despliegue (stable|canary) y correlation_id
 * (id de la SAGA). Además de stdout, si CLOUDWATCH_LOGS_ENABLED=true, envía
 * los eventos a CloudWatch Logs.
 */
export class Logger {
  private readonly sink?: CloudWatchSink;

  constructor(
    readonly service: string,
    private readonly base: LogFields = {},
    sink?: CloudWatchSink,
  ) {
    this.sink =
      sink ??
      (process.env.CLOUDWATCH_LOGS_ENABLED === 'true'
        ? new CloudWatchSink(`/aegisvolt/${getEnvironment()}/${service}`)
        : undefined);
  }

  child(fields: LogFields): Logger {
    return new Logger(this.service, { ...this.base, ...fields }, this.sink);
  }

  debug(msg: string, fields?: LogFields) { this.write('debug', msg, fields); }
  info(msg: string, fields?: LogFields) { this.write('info', msg, fields); }
  warn(msg: string, fields?: LogFields) { this.write('warn', msg, fields); }
  error(msg: string, fields?: LogFields) { this.write('error', msg, fields); }

  async flush() {
    await this.sink?.flush();
  }

  private write(level: Level, message: string, fields?: LogFields) {
    if (level === 'debug' && process.env.LOG_LEVEL !== 'debug') return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      environment: getEnvironment(),
      version: process.env.APP_VERSION ?? 'local',
      track: process.env.DEPLOY_TRACK ?? 'stable',
      message,
      ...this.base,
      ...fields,
    });
    if (process.env.NODE_ENV !== 'test' || process.env.LOG_IN_TESTS === 'true') process.stdout.write(line + '\n');
    this.sink?.push(line);
  }
}
