/**
 * Tarificación (COP por kWh). ENABLE_DYNAMIC_SURGE_PRICING activa tarifas
 * dinámicas: x1.5 en horas pico (America/Bogota 07-09 y 17-21) y x1.2 el
 * resto del día. ENABLE_FAST_CHARGE_BOOST añade un recargo del 15% a las
 * reservas prioritarias de ultra-carga.
 */
export const PEAK_MULTIPLIER = 1.5;
export const OFF_PEAK_DYNAMIC_MULTIPLIER = 1.2;
export const BOOST_FEE_RATE = 0.15;

export function baseRatePerKwh(powerKw: number): number {
  if (powerKw >= 150) return 1500;
  if (powerKw >= 50) return 1200;
  return 900;
}

export function isPeakHour(date = new Date(), timeZone = process.env.PRICING_TZ ?? 'America/Bogota'): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(date));
  return (hour >= 7 && hour < 9) || (hour >= 17 && hour < 21);
}

export interface Quote {
  ratePerKwh: number;
  surgeMultiplier: number;
  surgeActive: boolean;
  peakHour: boolean;
  boostFee: number;
  amount: number;
  currency: 'COP';
}

export function quote(input: {
  powerKw: number;
  energyKwh: number;
  priority: boolean;
  surgePricingEnabled: boolean;
  now?: Date;
}): Quote {
  if (!(input.energyKwh > 0) || input.energyKwh > 500) throw new RangeError('energyKwh debe estar entre 0 y 500');
  const ratePerKwh = baseRatePerKwh(input.powerKw);
  const peakHour = isPeakHour(input.now);
  const surgeMultiplier = input.surgePricingEnabled ? (peakHour ? PEAK_MULTIPLIER : OFF_PEAK_DYNAMIC_MULTIPLIER) : 1;
  const energyCost = Math.round(input.energyKwh * ratePerKwh * surgeMultiplier);
  const boostFee = input.priority ? Math.round(energyCost * BOOST_FEE_RATE) : 0;
  return {
    ratePerKwh,
    surgeMultiplier,
    surgeActive: surgeMultiplier > 1,
    peakHour,
    boostFee,
    amount: energyCost + boostFee,
    currency: 'COP',
  };
}
