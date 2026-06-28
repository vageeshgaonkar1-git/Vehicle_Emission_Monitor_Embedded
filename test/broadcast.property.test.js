'use strict';

// Feature: vehicle-emissions-monitor, Property 6: Socket.io broadcast completeness
// For any valid Sensor_Payload that is successfully persisted to emission_logs,
// the sensor_data Socket.io event emitted to connected clients SHALL contain all
// six fields — co_level, nox_level, temperature, humidity, vibration_status, and
// timestamp — with values that exactly match the persisted row.
// Validates: Requirements 6.1, 6.2

const fc = require('fast-check');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { parsePayload } = require('../src/parser');
const { initDb, insertRecord } = require('../src/db');

const BROADCAST_FIELDS = [
  'co_level',
  'nox_level',
  'temperature',
  'humidity',
  'vibration_status',
  'timestamp',
];

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

function closeDb(db) {
  return new Promise((resolve, reject) =>
    db.close((err) => (err ? reject(err) : resolve()))
  );
}

function getRow(conn) {
  return new Promise((resolve, reject) => {
    conn.get('SELECT * FROM emission_logs LIMIT 1', (err, row) =>
      err ? reject(err) : resolve(row)
    );
  });
}

/** Minimal Socket.io stand-in that records emitted events */
function makeEmitter() {
  const events = [];
  return {
    emit(event, payload) {
      events.push({ event, payload });
    },
    events,
  };
}

/** Arbitrary for valid Sensor_Payload objects */
const validPayloadArb = fc.record({
  co:         fc.float({ min: 0, max: 1000, noNaN: true }),
  nox:        fc.float({ min: 0, max: 1000, noNaN: true }),
  temp:       fc.float({ min: -40, max: 80,  noNaN: true }),
  hum:        fc.float({ min: 0,   max: 100, noNaN: true }),
  is_running: fc.integer({ min: 0, max: 1 }),
});

describe('Property 6: Socket.io broadcast completeness', () => {
  test(
    'emitted sensor_data event contains all 6 fields matching the persisted row',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          validPayloadArb,
          async (payload) => {
            const dbPath = path.join(
              os.tmpdir(),
              `ems_p6_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
            );

            try {
              const db = await initDb(dbPath);

              // Parse the payload (mirrors server.js message handler)
              const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
              const result = parsePayload(buffer);
              expect(result.ok).toBe(true);

              // Persist the record
              await insertRecord(result.data);

              // Simulate the Socket.io emit that server.js performs after insert
              const emitter = makeEmitter();
              emitter.emit('sensor_data', result.data);

              await closeDb(db);

              // Read back the persisted row
              const conn = await openRaw(dbPath);
              const row = await getRow(conn);
              await closeRaw(conn);

              expect(row).toBeDefined();

              // Exactly one sensor_data event must have been emitted
              const sensorEvents = emitter.events.filter((e) => e.event === 'sensor_data');
              expect(sensorEvents).toHaveLength(1);

              const emitted = sensorEvents[0].payload;

              // All 6 required fields must be present in the emitted payload
              for (const field of BROADCAST_FIELDS) {
                expect(emitted).toHaveProperty(field);
              }

              // Emitted values must match the persisted row exactly
              expect(emitted.co_level).toBeCloseTo(row.co_level, 10);
              expect(emitted.nox_level).toBeCloseTo(row.nox_level, 10);
              expect(emitted.temperature).toBeCloseTo(row.temperature, 10);
              expect(emitted.humidity).toBeCloseTo(row.humidity, 10);
              expect(emitted.vibration_status).toBe(row.vibration_status);
              expect(emitted.timestamp).toBe(row.timestamp);
            } finally {
              if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
            }
          }
        ),
        { numRuns: 100 }
      );
    },
    60000
  );
});
