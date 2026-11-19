import { createHash, randomUUID } from 'node:crypto';
import { FLAGS, type Logger } from '@aegisvolt/shared';
import { ServiceError } from '../clients.ts';
import type { SagaStore } from './store.ts';
import {
  TERMINAL_STATUSES,
  type FlagReader,
  type ReserveAndChargeInput,
  type SagaParticipants,
  type SagaRecord,
  type SagaStatus,
  type StepName,
} from './types.ts';

export interface OrchestratorOptions {
  compensationRetries?: number;
  retryBaseDelayMs?: number;
}

/**
 * Orquestador de la SAGA "Reservar y Activar Carga".
 *
 *   RESERVE (station-reservation) -> CHARGE (billing-wallet) -> DISPATCH (energy-dispatch)
 *
 * Si un paso falla, se ejecutan en orden inverso las compensaciones de todos
 * los pasos *intentados* (incluido el que falló, porque un timeout no dice si
 * se aplicó o no). Esto es seguro porque cada compensación es idempotente y
 * es un no-op si la acción original nunca ocurrió:
 *   DISPATCH -> stop sesión | CHARGE -> refund | RESERVE -> release (AVAILABLE)
 */
export class SagaOrchestrator {
  private readonly retries: number;
  private readonly baseDelay: number;

  constructor(
    private readonly store: SagaStore,
    private readonly participants: SagaParticipants,
    private readonly flags: FlagReader,
    private readonly logger: Logger,
    private readonly environment: string,
    opts: OrchestratorOptions = {},
  ) {
    this.retries = opts.compensationRetries ?? 3;
    this.baseDelay = opts.retryBaseDelayMs ?? 200;
  }

  static sagaIdFor(input: ReserveAndChargeInput): string {
    if (!input.idempotencyKey) return randomUUID();
    const h = createHash('sha256').update(`${input.fleetId}:${input.idempotencyKey}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  async reserveAndCharge(input: ReserveAndChargeInput): Promise<SagaRecord> {
    const sagaId = SagaOrchestrator.sagaIdFor(input);
    const now = new Date().toISOString();
    let saga: SagaRecord = {
      sagaId,
      correlationId: sagaId,
      idempotencyKey: input.idempotencyKey,
      status: 'STARTED',
      environment: this.environment,
      fleetId: input.fleetId,
      stationId: input.stationId,
      connectorId: input.connectorId,
      energyKwh: input.energyKwh,
      fastChargeBoost: Boolean(input.fastChargeBoost),
      attemptedSteps: [],
      steps: [],
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    if (!(await this.store.create(saga))) {
      // Misma idempotencyKey: se devuelve la SAGA original, no se re-ejecuta.
      this.logger.info('saga_idempotent_replay', { correlation_id: sagaId });
      return (await this.store.get(sagaId))!;
    }
    const log = this.logger.child({ correlation_id: sagaId, saga_id: sagaId });
    log.info('saga_started', { fleet_id: input.fleetId, station_id: input.stationId, connector_id: input.connectorId });

    // --- Validaciones previas (no tocan estado de otros servicios) ---
    const connector = await this.participants.getConnector(input.stationId, input.connectorId, sagaId);
    if (!connector) return this.reject(saga, 'VALIDATE', `Conector ${input.stationId}/${input.connectorId} no existe`, log);
    if (input.fastChargeBoost && !(await this.flags.isEnabled(FLAGS.ENABLE_FAST_CHARGE_BOOST))) {
      return this.reject(saga, 'VALIDATE', 'ENABLE_FAST_CHARGE_BOOST está deshabilitada en este ambiente', log);
    }
    if (input.fastChargeBoost && !connector.ultraFast) {
      return this.reject(saga, 'VALIDATE', 'La reserva prioritaria solo aplica a conectores de ultra-carga (>=150 kW)', log);
    }

    let quote;
    try {
      quote = await this.participants.quote(
        { powerKw: connector.powerKw, energyKwh: input.energyKwh, priority: Boolean(input.fastChargeBoost) },
        sagaId,
      );
    } catch (err) {
      return this.reject(saga, 'QUOTE', describe(err), log);
    }
    saga = await this.store.save(
      step({ ...saga, powerKw: connector.powerKw, amount: quote.amount, currency: quote.currency, surgeMultiplier: quote.surgeMultiplier }, 'QUOTE', 'SUCCEEDED', `${quote.amount} ${quote.currency} (x${quote.surgeMultiplier})`),
    );

    // --- Paso 1: reservar conector ---
    saga = await this.store.save({ ...saga, attemptedSteps: ['RESERVE'] });
    try {
      await this.participants.reserve(
        { sagaId, stationId: input.stationId, connectorId: input.connectorId, fleetId: input.fleetId, priority: Boolean(input.fastChargeBoost) },
        sagaId,
      );
      saga = await this.store.save(step({ ...saga, status: 'RESERVED' }, 'RESERVE', 'SUCCEEDED', 'Conector en RESERVED'));
      log.info('saga_step_succeeded', { saga_step: 'RESERVE' });
    } catch (err) {
      return this.fail(saga, 'RESERVE', err, log);
    }

    // --- Paso 2: cobrar a la billetera ---
    saga = await this.store.save({ ...saga, attemptedSteps: ['RESERVE', 'CHARGE'] });
    try {
      await this.participants.charge({ sagaId, fleetId: input.fleetId, amount: quote.amount }, sagaId);
      saga = await this.store.save(step({ ...saga, status: 'PAID' }, 'CHARGE', 'SUCCEEDED', `Descontados ${quote.amount} ${quote.currency}`));
      log.info('saga_step_succeeded', { saga_step: 'CHARGE', amount: quote.amount });
    } catch (err) {
      return this.fail(saga, 'CHARGE', err, log);
    }

    // --- Paso 3: activación física del cargador ---
    saga = await this.store.save({ ...saga, attemptedSteps: ['RESERVE', 'CHARGE', 'DISPATCH'] });
    try {
      await this.participants.startCharging(
        { sagaId, stationId: input.stationId, connectorId: input.connectorId, energyKwh: input.energyKwh, powerKw: connector.powerKw },
        sagaId,
      );
      saga = step(saga, 'DISPATCH', 'SUCCEEDED', 'Flujo eléctrico iniciado');
      log.info('saga_step_succeeded', { saga_step: 'DISPATCH' });
    } catch (err) {
      return this.fail(saga, 'DISPATCH', err, log);
    }

    // Pivot superado: desde aquí sólo hay pasos reintentables (no se compensa).
    try {
      await this.withRetry(() => this.participants.activateReservation(sagaId, sagaId));
      saga = step(saga, 'ACTIVATE', 'SUCCEEDED', 'Conector en CHARGING');
    } catch (err) {
      saga = step(saga, 'ACTIVATE', 'FAILED', describe(err));
      log.error('saga_activate_failed', { error: describe(err) });
    }
    saga = await this.store.save({ ...saga, status: 'COMPLETED' });
    log.info('saga_completed', { status: 'COMPLETED', amount: quote.amount });
    return saga;
  }

  /** Reintenta las compensaciones de una SAGA atascada o con compensación fallida. */
  async retryCompensation(sagaId: string): Promise<SagaRecord> {
    const saga = await this.store.get(sagaId);
    if (!saga) throw new Error(`SAGA ${sagaId} no existe`);
    if (saga.status !== 'COMPENSATION_FAILED' && saga.status !== 'COMPENSATING' && TERMINAL_STATUSES.includes(saga.status)) {
      throw new Error(`La SAGA está en ${saga.status}; sólo se reintentan SAGAs en COMPENSATING/COMPENSATION_FAILED o huérfanas`);
    }
    const log = this.logger.child({ correlation_id: sagaId, saga_id: sagaId });
    log.warn('saga_compensation_retry', { previous_status: saga.status });
    return this.compensate(saga, saga.failureReason ?? 'MANUAL_RETRY', log);
  }

  async stopCharging(sagaId: string): Promise<SagaRecord> {
    let saga = await this.store.get(sagaId);
    if (!saga) throw new Error(`SAGA ${sagaId} no existe`);
    if (saga.status !== 'COMPLETED') throw new Error(`Sólo se puede finalizar una SAGA COMPLETED (actual: ${saga.status})`);
    if (saga.steps.some((s) => s.name === 'STOP' && s.status === 'SUCCEEDED')) return saga;
    await this.participants.stopCharging(sagaId, sagaId);
    await this.participants.completeReservation(sagaId, sagaId);
    saga = await this.store.save(step(saga, 'STOP', 'SUCCEEDED', 'Carga finalizada, conector AVAILABLE'));
    this.logger.info('charging_stopped', { correlation_id: sagaId });
    return saga;
  }

  private async reject(saga: SagaRecord, at: StepName, reason: string, log: Logger) {
    log.warn('saga_rejected', { saga_step: at, reason });
    return this.store.save(step({ ...saga, status: 'REJECTED', failedStep: at, failureReason: reason }, at, 'FAILED', reason));
  }

  private async fail(saga: SagaRecord, at: 'RESERVE' | 'CHARGE' | 'DISPATCH', err: unknown, log: Logger) {
    const reason = describe(err);
    log.error('saga_step_failed', { saga_step: at, error: reason, error_code: (err as ServiceError).code });
    saga = await this.store.save(step({ ...saga, failedStep: at, failureReason: reason }, at, 'FAILED', reason));

    // Un rechazo definitivo (4xx) del primer paso significa que nada cambió.
    if (at === 'RESERVE' && err instanceof ServiceError && err.definitive) {
      log.warn('saga_failed_without_compensation', { saga_step: at });
      return this.store.save({ ...saga, status: 'FAILED' });
    }
    return this.compensate(saga, reason, log);
  }

  private async compensate(saga: SagaRecord, reason: string, log: Logger): Promise<SagaRecord> {
    saga = await this.store.save({ ...saga, status: 'COMPENSATING' });
    log.warn('saga_compensation_started', { attempted_steps: saga.attemptedSteps, reason });

    const compensations: Record<'RESERVE' | 'CHARGE' | 'DISPATCH', [StepName, () => Promise<void>]> = {
      DISPATCH: ['COMPENSATE_DISPATCH', () => this.participants.stopCharging(saga.sagaId, saga.sagaId)],
      CHARGE: ['COMPENSATE_CHARGE', () => this.participants.refund({ sagaId: saga.sagaId, fleetId: saga.fleetId, reason }, saga.sagaId)],
      RESERVE: ['COMPENSATE_RESERVE', () => this.participants.releaseReservation(saga.sagaId, reason, saga.sagaId)],
    };

    for (const forward of [...saga.attemptedSteps].reverse()) {
      const [name, action] = compensations[forward];
      const alreadyDone = saga.steps.some((s) => s.name === name && s.status === 'SUCCEEDED');
      if (alreadyDone) continue;
      try {
        await this.withRetry(action, (attempt, err) => log.warn('saga_compensation_retrying', { saga_step: name, attempt, error: describe(err) }));
        saga = await this.store.save(step(saga, name, 'SUCCEEDED', compensationDetail(name)));
        log.warn('saga_compensation_succeeded', { saga_step: name });
      } catch (err) {
        saga = await this.store.save(step({ ...saga, status: 'COMPENSATION_FAILED' }, name, 'FAILED', describe(err)));
        log.error('saga_compensation_failed', { saga_step: name, error: describe(err) });
        return saga;
      }
    }
    saga = await this.store.save({ ...saga, status: 'COMPENSATED' });
    log.warn('saga_compensated', { status: 'COMPENSATED' });
    return saga;
  }

  private async withRetry(fn: () => Promise<void>, onRetry?: (attempt: number, err: unknown) => void) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        // 404 en una compensación = el recurso nunca se creó: nada que deshacer.
        if (err instanceof ServiceError && err.status === 404) return;
        if (attempt >= this.retries) throw err;
        onRetry?.(attempt, err);
        await new Promise((r) => setTimeout(r, this.baseDelay * 2 ** (attempt - 1)));
      }
    }
  }
}

function step(saga: SagaRecord, name: StepName, status: 'SUCCEEDED' | 'FAILED', detail?: string): SagaRecord {
  return { ...saga, steps: [...saga.steps, { name, status, at: new Date().toISOString(), detail }] };
}

function compensationDetail(name: StepName) {
  switch (name) {
    case 'COMPENSATE_DISPATCH':
      return 'Sesión de carga detenida';
    case 'COMPENSATE_CHARGE':
      return 'Saldo reembolsado a la billetera';
    default:
      return 'Conector liberado (AVAILABLE)';
  }
}

function describe(err: unknown): string {
  if (err instanceof ServiceError) return `${err.service}: ${err.code} - ${err.message}`;
  return (err as Error)?.message ?? String(err);
}

export type { SagaStatus };
