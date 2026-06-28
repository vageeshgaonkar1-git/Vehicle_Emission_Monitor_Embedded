'use strict';

// Feature: vehicle-emissions-monitor, Property 10: DHT22 correction output range
// For any valid temperature (−40°C to 80°C), humidity (0% to 100%), and raw ADC
// value (0 to 4095), the DHT22 environmental correction function SHALL return a
// corrected gas concentration value that is a non-negative finite number.
// Validates: Requirements 13.2

const fc = require('fast-check');
const { dht22CorrectGas } = require('../src/uartFrame');

describe('Property 10: DHT22 correction output range', () => {
  test(
    'for any valid temp/humidity/ADC input, dht22CorrectGas returns a non-negative finite number',
    () => {
      fc.assert(
        fc.property(
          fc.float({ min: -40, max: 80,  noNaN: true }),   // temperature °C
          fc.float({ min: 0,   max: 100, noNaN: true }),   // humidity %
          fc.integer({ min: 0, max: 4095 }),               // 12-bit ADC
          (temperature, humidity, rawAdc) => {
            const result = dht22CorrectGas(rawAdc, temperature, humidity);
            expect(typeof result).toBe('number');
            expect(isFinite(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(0);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
