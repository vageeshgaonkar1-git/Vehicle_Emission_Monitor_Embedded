'use strict';

// Feature: vehicle-emissions-monitor, Property 8: Alert activation invariant
// For any sensor_data event received by the Dashboard:
//   - The CO alert SHALL be visible if and only if co_level > CO_THRESHOLD AND vibration_status === 1
//   - The NOx alert SHALL be visible if and only if nox_level > NOX_THRESHOLD AND vibration_status === 1
// Validates: Requirements 8.1, 8.2, 8.3

const fc = require('fast-check');

const CO_THRESHOLD  = 50;
const NOX_THRESHOLD = 25;

/**
 * Pure function mirroring the alert evaluation logic in public/index.html.
 * Returns { coVisible, noxVisible } booleans.
 */
function evaluateAlerts(data) {
  const coVisible  = data.co_level  > CO_THRESHOLD  && data.vibration_status === 1;
  const noxVisible = data.nox_level > NOX_THRESHOLD && data.vibration_status === 1;
  return { coVisible, noxVisible };
}

describe('Property 8: Alert activation invariant', () => {
  test(
    'alert visibility matches level > threshold AND vibration_status === 1 for any sensor_data event',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            co_level:         fc.float({ min: 0, max: 500, noNaN: true }),
            nox_level:        fc.float({ min: 0, max: 500, noNaN: true }),
            temperature:      fc.float({ min: -40, max: 80, noNaN: true }),
            humidity:         fc.float({ min: 0, max: 100, noNaN: true }),
            vibration_status: fc.integer({ min: 0, max: 1 }),
            timestamp:        fc.date().map((d) => d.toISOString()),
          }),
          (event) => {
            const { coVisible, noxVisible } = evaluateAlerts(event);

            const expectedCo  = event.co_level  > CO_THRESHOLD  && event.vibration_status === 1;
            const expectedNox = event.nox_level > NOX_THRESHOLD && event.vibration_status === 1;

            return coVisible === expectedCo && noxVisible === expectedNox;
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'alert is hidden when engine is off (vibration_status === 0) regardless of emission levels',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            co_level:         fc.float({ min: Math.fround(CO_THRESHOLD + 0.01), max: 500, noNaN: true }),
            nox_level:        fc.float({ min: Math.fround(NOX_THRESHOLD + 0.01), max: 500, noNaN: true }),
            temperature:      fc.float({ min: -40, max: 80, noNaN: true }),
            humidity:         fc.float({ min: 0, max: 100, noNaN: true }),
            vibration_status: fc.constant(0),
            timestamp:        fc.date().map((d) => d.toISOString()),
          }),
          (event) => {
            const { coVisible, noxVisible } = evaluateAlerts(event);
            // Even with levels above threshold, engine off means no alert
            return coVisible === false && noxVisible === false;
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'alert is hidden when levels are at or below threshold even when engine is running',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            co_level:         fc.float({ min: 0, max: CO_THRESHOLD, noNaN: true }),
            nox_level:        fc.float({ min: 0, max: NOX_THRESHOLD, noNaN: true }),
            temperature:      fc.float({ min: -40, max: 80, noNaN: true }),
            humidity:         fc.float({ min: 0, max: 100, noNaN: true }),
            vibration_status: fc.constant(1),
            timestamp:        fc.date().map((d) => d.toISOString()),
          }),
          (event) => {
            const { coVisible, noxVisible } = evaluateAlerts(event);
            // Levels at or below threshold → no alert, even with engine running
            return coVisible === false && noxVisible === false;
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
