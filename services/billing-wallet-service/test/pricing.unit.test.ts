import { describe, expect, it } from 'vitest';
import { isPeakHour, quote } from '../src/pricing.ts';

// 18:30 en Bogotá (UTC-5) = 23:30 UTC -> hora pico
const PEAK = new Date('2026-11-18T23:30:00Z');
// 12:00 en Bogotá = 17:00 UTC -> fuera de pico
const OFF_PEAK = new Date('2026-11-18T17:00:00Z');

describe('pricing', () => {
  it('detecta horas pico en America/Bogota', () => {
    expect(isPeakHour(PEAK)).toBe(true);
    expect(isPeakHour(OFF_PEAK)).toBe(false);
  });

  it('sin surge pricing cobra tarifa plana', () => {
    const q = quote({ powerKw: 150, energyKwh: 10, priority: false, surgePricingEnabled: false, now: PEAK });
    expect(q).toMatchObject({ ratePerKwh: 1500, surgeMultiplier: 1, surgeActive: false, amount: 15000 });
  });

  it('con surge pricing aplica x1.5 en hora pico y x1.2 fuera de pico', () => {
    expect(quote({ powerKw: 150, energyKwh: 10, priority: false, surgePricingEnabled: true, now: PEAK }).amount).toBe(22500);
    expect(quote({ powerKw: 150, energyKwh: 10, priority: false, surgePricingEnabled: true, now: OFF_PEAK }).amount).toBe(18000);
  });

  it('la reserva prioritaria agrega 15% de recargo', () => {
    const q = quote({ powerKw: 350, energyKwh: 20, priority: true, surgePricingEnabled: false, now: OFF_PEAK });
    expect(q.boostFee).toBe(4500);
    expect(q.amount).toBe(34500);
  });

  it('rechaza energía fuera de rango', () => {
    expect(() => quote({ powerKw: 50, energyKwh: 0, priority: false, surgePricingEnabled: false })).toThrow(RangeError);
  });
});
