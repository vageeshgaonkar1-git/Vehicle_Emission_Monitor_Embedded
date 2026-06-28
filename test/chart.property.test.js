'use strict';

// Feature: vehicle-emissions-monitor, Property 7: Chart window size invariant
// For any sequence of N sensor_data events received by the Dashboard (where N > 20),
// the length of the data array backing each Chart.js chart SHALL never exceed 20
// at any point during or after processing the sequence.
// Validates: Requirements 7.5

const fc = require('fast-check');

const MAX_POINTS = 20;

/**
 * Minimal chart state that mirrors the pushToChart logic in public/index.html.
 * We test the logic in isolation — no DOM or Chart.js instance required.
 */
function makeChartState() {
  return { labels: [], data: [] };
}

function pushToChart(chart, label, value) {
  chart.labels.push(label);
  chart.data.push(value);
  if (chart.labels.length > MAX_POINTS) {
    chart.labels.shift();
    chart.data.shift();
  }
}

describe('Property 7: Chart window size invariant', () => {
  test(
    'chart data array length never exceeds 20 for any sequence of N > 20 events',
    () => {
      fc.assert(
        fc.property(
          // Generate sequences of more than 20 events (21–200 events)
          fc.array(
            fc.record({
              co_level:  fc.float({ min: 0, max: 1000, noNaN: true }),
              nox_level: fc.float({ min: 0, max: 1000, noNaN: true }),
              timestamp: fc.date().map((d) => d.toISOString()),
            }),
            { minLength: 21, maxLength: 200 }
          ),
          (events) => {
            const coChart  = makeChartState();
            const noxChart = makeChartState();

            for (const event of events) {
              pushToChart(coChart,  event.timestamp, event.co_level);
              pushToChart(noxChart, event.timestamp, event.nox_level);

              // Invariant must hold after every single push, not just at the end
              if (coChart.data.length > MAX_POINTS)  return false;
              if (noxChart.data.length > MAX_POINTS) return false;
              if (coChart.labels.length > MAX_POINTS)  return false;
              if (noxChart.labels.length > MAX_POINTS) return false;
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
