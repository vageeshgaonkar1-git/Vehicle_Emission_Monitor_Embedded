'use strict';

// Feature: vehicle-emissions-monitor, Property 9: UART_Frame round-trip
// For any set of sensor reading values (co, nox, temp, hum, is_running as 0/1,
// timestamp as ISO 8601), formatting them into a UART_Frame and then parsing
// the resulting JSON string SHALL produce an object with field values equivalent
// to the original inputs. Edge case: is_running in the parsed output SHALL
// always be a numeric integer 0 or 1, never a boolean.
// Validates: Requirements 11.2, 13.3

const fc = require('fast-check');
const { formatFrame, parseFrame } = require('../src/uartFrame');

/** Arbitrary for valid ISO 8601 timestamp strings */
const iso8601Arb = fc
  .date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2099-12-31T23:59:59.999Z'),
  })
  .map((d) => d.toISOString());

/** Arbitrary for a complete sensor reading set */
const sensorReadingArb = fc.record({
  co:         fc.float({ min: 0, max: 1000, noNaN: true }),
  nox:        fc.float({ min: 0, max: 1000, noNaN: true }),
  temp:       fc.float({ min: -40, max: 80,  noNaN: true }),
  hum:        fc.float({ min: 0,   max: 100, noNaN: true }),
  is_running: fc.integer({ min: 0, max: 1 }),
  timestamp:  iso8601Arb,
});

describe('Property 9: UART_Frame round-trip', () => {
  test(
    'format → parse produces equivalent field values for any sensor reading set',
    () => {
      fc.assert(
        fc.property(sensorReadingArb, (reading) => {
          const frame = formatFrame(reading);

          // Frame must be a string terminated by \n
          expect(typeof frame).toBe('string');
          expect(frame.endsWith('\n')).toBe(true);

          const result = parseFrame(frame);
          expect(result.ok).toBe(true);

          const parsed = result.data;

          // All field values must survive the round-trip
          expect(parsed.co).toBeCloseTo(reading.co, 10);
          expect(parsed.nox).toBeCloseTo(reading.nox, 10);
          expect(parsed.temp).toBeCloseTo(reading.temp, 10);
          expect(parsed.hum).toBeCloseTo(reading.hum, 10);
          expect(parsed.timestamp).toBe(reading.timestamp);

          // is_running must be a numeric integer 0 or 1, never a boolean
          expect(typeof parsed.is_running).toBe('number');
          expect(parsed.is_running === 0 || parsed.is_running === 1).toBe(true);
          expect(parsed.is_running).toBe(reading.is_running);
        }),
        { numRuns: 100 }
      );
    }
  );
});
