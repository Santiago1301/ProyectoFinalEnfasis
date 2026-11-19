export type Env = 'dev' | 'test' | 'prod';
export type ConnectorStatus = 'AVAILABLE' | 'RESERVED' | 'CHARGING' | 'FAULTED';

export interface Connector {
  connectorId: string;
  status: ConnectorStatus;
  powerKw: number;
  plugType: string;
  ultraFast: boolean;
  reservationSagaId?: string | null;
}

export interface Station {
  stationId: string;
  name: string;
  city: string;
  address?: string;
  availableConnectors: number;
  connectors: Connector[];
}

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description?: string;
  environment: Env;
  updatedAt?: string;
  updatedBy?: string;
}

export interface Wallet {
  fleetId: string;
  fleetName: string;
  balance: number;
  currency: string;
}

export interface WalletTx {
  txId: string;
  sagaId: string;
  type: 'CHARGE' | 'REFUND';
  amount: number;
  status: string;
  reason?: string;
  createdAt: string;
}

export interface SagaStep {
  name: string;
  status: 'SUCCEEDED' | 'FAILED' | 'RETRYING';
  at: string;
  detail?: string;
}

export type SagaStatus =
  | 'STARTED' | 'RESERVED' | 'PAID' | 'COMPLETED' | 'COMPENSATING'
  | 'COMPENSATED' | 'FAILED' | 'COMPENSATION_FAILED' | 'REJECTED';

export interface TelemetryPoint {
  timestamp: string;
  powerKw: number;
  deliveredKwh: number;
  stateOfCharge: number;
}

export interface ChargingSession {
  status: string;
  deliveredKwh: number;
  energyKwhTarget: number;
  powerKw: number;
  faultCode?: string | null;
  telemetry: TelemetryPoint[];
}

export interface Saga {
  sagaId: string;
  status: SagaStatus;
  fleetId: string;
  stationId: string;
  connectorId: string;
  energyKwh: number;
  fastChargeBoost: boolean;
  amount?: number | null;
  currency?: string | null;
  surgeMultiplier?: number | null;
  failedStep?: string | null;
  failureReason?: string | null;
  steps: SagaStep[];
  createdAt: string;
  session?: ChargingSession | null;
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

export interface EnvironmentInfo {
  environment: Env;
  version: string;
  flagMutationsAllowed: boolean;
  services: { name: string; status: string; version?: string; track?: string; latencyMs?: number }[];
}
