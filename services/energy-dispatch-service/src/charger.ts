import type { ChargingSession, TelemetryPoint } from './repository.ts';

/**
 * Simulador del hardware del cargador. En producción esta clase hablaría
 * OCPP con el cargador físico; aquí genera telemetría plausible.
 */
export const SIMULATION_SPEEDUP = Number(process.env.CHARGER_SIMULATION_SPEEDUP ?? 60);

export function nextTelemetry(session: ChargingSession, elapsedMs: number, now = new Date()): TelemetryPoint {
  const hours = (elapsedMs / 3_600_000) * SIMULATION_SPEEDUP;
  // Curva de carga: potencia plena hasta 80% del objetivo, luego decae.
  const progress = session.deliveredKwh / session.energyKwhTarget;
  const taper = progress < 0.8 ? 1 : Math.max(0.25, 1 - (progress - 0.8) * 3.5);
  const jitter = 0.95 + Math.random() * 0.05;
  const powerKw = round(session.powerKw * taper * jitter);
  const deliveredKwh = round(Math.min(session.energyKwhTarget, session.deliveredKwh + powerKw * hours));
  const voltage = round(session.powerKw >= 150 ? 800 + Math.random() * 20 : 400 + Math.random() * 10);
  return {
    timestamp: now.toISOString(),
    powerKw,
    voltage,
    currentA: round((powerKw * 1000) / voltage),
    deliveredKwh,
    stateOfCharge: round(Math.min(100, 20 + (deliveredKwh / session.energyKwhTarget) * 75)),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
