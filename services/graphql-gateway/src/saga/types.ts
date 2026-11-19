export type SagaStatus =
  | 'STARTED'
  | 'RESERVED'
  | 'PAID'
  | 'COMPLETED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'FAILED'
  | 'COMPENSATION_FAILED'
  | 'REJECTED';

export const TERMINAL_STATUSES: SagaStatus[] = ['COMPLETED', 'COMPENSATED', 'FAILED', 'COMPENSATION_FAILED', 'REJECTED'];

export type StepName =
  | 'VALIDATE'
  | 'QUOTE'
  | 'RESERVE'
  | 'CHARGE'
  | 'DISPATCH'
  | 'ACTIVATE'
  | 'COMPENSATE_DISPATCH'
  | 'COMPENSATE_CHARGE'
  | 'COMPENSATE_RESERVE'
  | 'STOP';

export interface SagaStep {
  name: StepName;
  status: 'SUCCEEDED' | 'FAILED' | 'RETRYING';
  at: string;
  detail?: string;
}

export interface SagaRecord {
  sagaId: string;
  correlationId: string;
  idempotencyKey?: string;
  status: SagaStatus;
  environment: string;
  fleetId: string;
  stationId: string;
  connectorId: string;
  energyKwh: number;
  fastChargeBoost: boolean;
  powerKw?: number;
  amount?: number;
  currency?: string;
  surgeMultiplier?: number;
  failedStep?: StepName;
  failureReason?: string;
  /** Pasos "hacia adelante" que se intentaron; se compensan en orden inverso. */
  attemptedSteps: ('RESERVE' | 'CHARGE' | 'DISPATCH')[];
  steps: SagaStep[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ReserveAndChargeInput {
  fleetId: string;
  stationId: string;
  connectorId: string;
  energyKwh: number;
  fastChargeBoost?: boolean;
  idempotencyKey?: string;
}

export interface Quote {
  ratePerKwh: number;
  surgeMultiplier: number;
  surgeActive: boolean;
  peakHour: boolean;
  boostFee: number;
  amount: number;
  currency: string;
}

/** Puerto hacia los microservicios participantes (inyectable para pruebas). */
export interface SagaParticipants {
  getConnector(stationId: string, connectorId: string, cid: string): Promise<{ powerKw: number; ultraFast: boolean; status: string } | undefined>;
  quote(input: { powerKw: number; energyKwh: number; priority: boolean }, cid: string): Promise<Quote>;
  reserve(input: { sagaId: string; stationId: string; connectorId: string; fleetId: string; priority: boolean }, cid: string): Promise<void>;
  releaseReservation(sagaId: string, reason: string, cid: string): Promise<void>;
  activateReservation(sagaId: string, cid: string): Promise<void>;
  completeReservation(sagaId: string, cid: string): Promise<void>;
  charge(input: { sagaId: string; fleetId: string; amount: number }, cid: string): Promise<void>;
  refund(input: { sagaId: string; fleetId: string; reason: string }, cid: string): Promise<void>;
  startCharging(input: { sagaId: string; stationId: string; connectorId: string; energyKwh: number; powerKw: number }, cid: string): Promise<void>;
  stopCharging(sagaId: string, cid: string): Promise<void>;
}

export interface FlagReader {
  isEnabled(name: string): Promise<boolean>;
}
