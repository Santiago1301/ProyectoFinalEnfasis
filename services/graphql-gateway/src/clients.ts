import { CORRELATION_HEADER } from '@aegisvolt/shared';

/** Error devuelto por un microservicio (o de red / timeout). */
export class ServiceError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }

  /** Errores 4xx son rechazos de negocio definitivos; 5xx/red son resultados inciertos. */
  get definitive(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

const TIMEOUT_MS = Number(process.env.SERVICE_TIMEOUT_MS ?? 5000);

export class HttpServiceClient {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
  ) {}

  async request<T>(method: 'GET' | 'POST', path: string, correlationId?: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ServiceError(this.name, 503, 'SERVICE_UNREACHABLE', `${this.name}: ${(err as Error).message}`);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new ServiceError(this.name, res.status, json?.error ?? 'UNKNOWN', json?.message ?? res.statusText, json);
    }
    return json as T;
  }

  get<T>(path: string, correlationId?: string) {
    return this.request<T>('GET', path, correlationId);
  }

  post<T>(path: string, body: unknown, correlationId?: string) {
    return this.request<T>('POST', path, correlationId, body);
  }

  async health(): Promise<{ name: string; status: string; version?: string; track?: string; latencyMs: number }> {
    const start = Date.now();
    try {
      const body = await this.get<{ version?: string; track?: string }>('/health/ready');
      return { name: this.name, status: 'UP', version: body.version, track: body.track, latencyMs: Date.now() - start };
    } catch {
      return { name: this.name, status: 'DOWN', latencyMs: Date.now() - start };
    }
  }
}

export interface ServiceClients {
  reservation: HttpServiceClient;
  billing: HttpServiceClient;
  dispatch: HttpServiceClient;
}

export function createServiceClients(): ServiceClients {
  return {
    reservation: new HttpServiceClient(
      'station-reservation-service',
      process.env.RESERVATION_SERVICE_URL ?? 'http://localhost:4001',
    ),
    billing: new HttpServiceClient('billing-wallet-service', process.env.BILLING_SERVICE_URL ?? 'http://localhost:4002'),
    dispatch: new HttpServiceClient('energy-dispatch-service', process.env.DISPATCH_SERVICE_URL ?? 'http://localhost:4003'),
  };
}
