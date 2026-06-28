'use strict';

// Feature: vehicle-emissions-monitor, Property 11: Table creation idempotence
// For any number of Server startup cycles against the same emissions.db file,
// the emission_logs table SHALL exist with the correct schema after each startup,
// and previously inserted rows SHALL be preserved.
// Validates: Requirements 3.2

const fc = require('fast-check');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { initDb, insertRecord } = require('../src/db');

const EXPECTED_COLUMNS = [
  'id',
  'timestamp',
  'co_level',
  'nox_level',
  'temperature',
  'humidity',
  'vibration_status',
];

/** Open a raw sqlite3 connection to inspect schema/rows */
function openRaw(dbPath) {
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(dbPath, (err) =>
      err ? reject(err) : resolve(conn)
    );
  });
}

function closeRaw(conn) {
  return new Promise((resolve, reject) =>
    conn.close((err) => (err ? reject(err) : resolve()))
  );
}

function getColumns(conn) {
  return new Promise((resolve, reject) => {
    conn.all('PRAGMA table_info(emission_logs)', (err, rows) =>
      err ? reject(err) : resolve(rows.map((r) => r.name))
    );
  });
}

function getRowCount(conn) {
  return new Promise((resolve, reject) => {
    conn.get('SELECT COUNT(*) as cnt FROM emission_logs', (err, row) =>
      err ? reject(err) : resolve(row.cnt)
    );
  });
}

/** Close the db handle returned by initDb so we can reopen it */
function closeDb(db) {
  return new Promise((resolve, reject) =>
    db.close((err) => (err ? reject(err) : resolve()))
  );
}

/** Build a minimal valid record */
function makeRecord(co, nox, temp, hum, isRunning) {
  return {
    timestamp: new Date().toISOString(),
    co_level: co,
    nox_level: nox,
    temperature: temp,
    humidity: hum,
    vibration_status: isRunning,
  };
}

describe('Property 11: Table creation idempotence', () => {
  test(
    'calling initDb() multiple times preserves schema and existing rows',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Number of extra initDb calls after the first (1..5)
          fc.integer({ min: 1, max: 5 }),
          // Number of rows to pre-insert before re-initialising
          fc.integer({ min: 0, max: 5 }),
          // Arbitrary sensor values for pre-inserted rows
          fc.array(
            fc.record({
              co: fc.float({ min: 0, max: 500, noNaN: true }),
              nox: fc.float({ min: 0, max: 500, noNaN: true }),
              temp: fc.float({ min: -40, max: 80, noNaN: true }),
              hum: fc.float({ min: 0, max: 100, noNaN: true }),
              isRunning: fc.integer({ min: 0, max: 1 }),
            }),
            { minLength: 0, maxLength: 5 }
          ),
          async (extraInits, _rowCount, sensorValues) => {
            // Use a unique temp file per run
            const dbPath = path.join(
              os.tmpdir(),
              `ems_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
            );

            try {
              // First init
              let db = await initDb(dbPath);

              // Insert some rows
              for (const v of sensorValues) {
                await insertRecord(makeRecord(v.co, v.nox, v.temp, v.hum, v.isRunning));
              }

              const expectedRowCount = sensorValues.length;

              // Close and re-init multiple times
              for (let i = 0; i < extraInits; i++) {
                await closeDb(db);
                db = await initDb(dbPath);
              }

              await closeDb(db);

              // Inspect the final state with a raw connection
              const conn = await openRaw(dbPath);
              const columns = await getColumns(conn);
              const rowCount = await getRowCount(conn);
              await closeRaw(conn);

              // Schema must be intact
              for (const col of EXPECTED_COLUMNS) {
                expect(columns).toContain(col);
              }

              // Previously inserted rows must be preserved
              expect(rowCount).toBe(expectedRowCount);
            } finally {
              if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
            }
          }
        ),
        { numRuns: 100 }
      );
    },
    30000
  );
});
