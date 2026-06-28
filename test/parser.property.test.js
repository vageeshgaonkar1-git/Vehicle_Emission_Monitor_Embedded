'use strict';

// Feature: vehicle-emissions-monitor, Property 2: Hardware timestamp preserved
// For any Sensor_Payload that contains a valid ISO 8601 timestamp string, the
// timestamp stored in emission_logs SHALL equal the hardware-provided timestamp
// exactly, not the server system time.
// Validates: Requirements 4.3

// Feature: vehicle-emissions-monitor, Property 1: Payload round-trip persistence
// For any valid Sensor_Payload, the values stored in emission_logs SHALL exactly
// match the parsed values from the payload:
//   co → co_level, nox → nox_level, temp → temperature,
//   hum → humidity, is_running → vibration_status
// Validates: Requirements 4.2, 5.1

const fc = require('fast-check');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { parsePayload, isValidIso8601 } = require('../src/parser');
const { initDb, insertRecord } = require('../src/db');

/** Open a raw sqlite3 connection for inspection */
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

/** Fetch the single row from emission_logs */
function getRow(conn) {
  return new Promise((resolve, reject) => {
    conn.get('SELECT * FROM emission_logs LIMIT 1', (err, row) =>
      err ? reject(err) : resolve(row)
    );
  });
}

/** Arbitrary for valid Sensor_Payload objects */
const validPayloadArb = fc.record({
  co:         fc.float({ min: 0, max: 1000, noNaN: true }),
  nox:        fc.float({ min: 0, max: 1000, noNaN: true }),
  temp:       fc.float({ min: -40, max: 80,  noNaN: true }),
  hum:        fc.float({ min: 0,   max: 100, noNaN: true }),
  is_running: fc.integer({ min: 0, max: 1 }),
});

describe('Property 1: Payload round-trip persistence', () => {
  test(
    'parsed field values survive parse → store cycle',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          validPayloadArb,
          async (payload) => {
            const dbPath = path.join(
              os.tmpdir(),
              `ems_p1_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
            );

            try {
              const db = await initDb(dbPath);

              // Parse the payload (as the server would after receiving an MQTT message)
              const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
              const result = parsePayload(buffer);

              expect(result.ok).toBe(true);

              // Persist the parsed record
              await insertRecord(result.data);
              await closeDb(db);

              // Read back the stored row
              const conn = await openRaw(dbPath);
              const row = await getRow(conn);
              await closeRaw(conn);

              expect(row).toBeDefined();

              // Field mapping assertions
              expect(row.co_level).toBeCloseTo(payload.co, 10);
              expect(row.nox_level).toBeCloseTo(payload.nox, 10);
              expect(row.temperature).toBeCloseTo(payload.temp, 10);
              expect(row.humidity).toBeCloseTo(payload.hum, 10);
              expect(row.vibration_status).toBe(payload.is_running);
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

// ---------------------------------------------------------------------------
// Property 2: Hardware timestamp preserved
// Feature: vehicle-emissions-monitor, Property 2: Hardware timestamp preserved
// For any Sensor_Payload that contains a valid ISO 8601 timestamp string, the
// timestamp stored in emission_logs SHALL equal the hardware-provided timestamp
// exactly, not the server system time.
// Validates: Requirements 4.3
// ---------------------------------------------------------------------------

/** Arbitrary for valid ISO 8601 timestamp strings */
const iso8601Arb = fc
  .date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2099-12-31T23:59:59.999Z') })
  .map((d) => d.toISOString());

/** Arbitrary for valid Sensor_Payload objects that include a hardware timestamp */
const payloadWithTimestampArb = fc.record({
  co:         fc.float({ min: 0, max: 1000, noNaN: true }),
  nox:        fc.float({ min: 0, max: 1000, noNaN: true }),
  temp:       fc.float({ min: -40, max: 80,  noNaN: true }),
  hum:        fc.float({ min: 0,   max: 100, noNaN: true }),
  is_running: fc.integer({ min: 0, max: 1 }),
  timestamp:  iso8601Arb,
});

describe('Property 2: Hardware timestamp preserved', () => {
  test(
    'stored timestamp equals hardware-provided ISO 8601 timestamp',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          payloadWithTimestampArb,
          async (payload) => {
            const dbPath = path.join(
              os.tmpdir(),
              `ems_p2_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
            );

            try {
              const db = await initDb(dbPath);

              const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
              const result = parsePayload(buffer);

              expect(result.ok).toBe(true);
              // The parsed timestamp must equal the hardware-provided one
              expect(result.data.timestamp).toBe(payload.timestamp);

              await insertRecord(result.data);
              await closeDb(db);

              const conn = await openRaw(dbPath);
              const row = await getRow(conn);
              await closeRaw(conn);

              expect(row).toBeDefined();
              // The persisted timestamp must equal the hardware-provided one
              expect(row.timestamp).toBe(payload.timestamp);
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

// ---------------------------------------------------------------------------
// Property 3: Server-time fallback
// Feature: vehicle-emissions-monitor, Property 3: Server-time fallback
// For any Sensor_Payload that either omits the timestamp field or provides a
// value that is not a valid ISO 8601 string, the timestamp stored in
// emission_logs SHALL be a valid ISO 8601 string generated from the server's
// system clock at the time of receipt.
// Validates: Requirements 4.4
// ---------------------------------------------------------------------------

/** Arbitrary for invalid / missing timestamp values */
const invalidTimestampArb = fc.oneof(
  // Missing timestamp field entirely — payload has no timestamp key
  validPayloadArb,
  // Payload with an explicitly invalid timestamp value
  fc.record({
    co:         fc.float({ min: 0, max: 1000, noNaN: true }),
    nox:        fc.float({ min: 0, max: 1000, noNaN: true }),
    temp:       fc.float({ min: -40, max: 80,  noNaN: true }),
    hum:        fc.float({ min: 0,   max: 100, noNaN: true }),
    is_running: fc.integer({ min: 0, max: 1 }),
    timestamp:  fc.oneof(
      fc.constant(null),
      fc.constant(''),
      fc.constant('not-a-date'),
      fc.constant(12345),
      fc.constant(false),
      fc.string().filter(s => !isValidIso8601(s))
    ),
  })
);

/** Returns true if a string is a valid ISO 8601 date */
function isIso8601(str) {
  if (typeof str !== 'string' || str.trim() === '') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

describe('Property 3: Server-time fallback', () => {
  test(
    'stored timestamp is a valid ISO 8601 string when payload timestamp is missing or invalid',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          invalidTimestampArb,
          async (payload) => {
            const dbPath = path.join(
              os.tmpdir(),
              `ems_p3_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
            );

            try {
              const db = await initDb(dbPath);

              const before = Date.now();
              const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
              const result = parsePayload(buffer);
              const after = Date.now();

              expect(result.ok).toBe(true);

              // The resolved timestamp must be a valid ISO 8601 string
              expect(isIso8601(result.data.timestamp)).toBe(true);

              // It must NOT equal the (invalid/missing) payload timestamp
              const payloadTs = (payload).timestamp;
              if (!isIso8601(payloadTs)) {
                // The server fell back to system time — verify it's within a
                // reasonable window (±5 s) around the test execution time
                const stored = new Date(result.data.timestamp).getTime();
                expect(stored).toBeGreaterThanOrEqual(before - 5000);
                expect(stored).toBeLessThanOrEqual(after + 5000);
              }

              await insertRecord(result.data);
              await closeDb(db);

              const conn = await openRaw(dbPath);
              const row = await getRow(conn);
              await closeRaw(conn);

              expect(row).toBeDefined();
              expect(isIso8601(row.timestamp)).toBe(true);
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

// ---------------------------------------------------------------------------
// Property 4: Invalid payload rejection
// Feature: vehicle-emissions-monitor, Property 4: Invalid payload rejection
// For any message that is either (a) not parseable as JSON, or (b) a valid JSON
// object missing one or more required fields, the total row count of
// emission_logs SHALL remain unchanged after the Server processes the message.
// Validates: Requirements 4.5, 4.6
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS_LIST = ['co', 'nox', 'temp', 'hum', 'is_running'];

/** Arbitrary for non-JSON strings */
const nonJsonArb = fc.string().filter((s) => {
  try { JSON.parse(s); return false; } catch { return true; }
});

/** Arbitrary for valid JSON objects missing at least one required field */
const missingFieldPayloadArb = fc
  .record({
    co:         fc.float({ min: 0, max: 1000, noNaN: true }),
    nox:        fc.float({ min: 0, max: 1000, noNaN: true }),
    temp:       fc.float({ min: -40, max: 80,  noNaN: true }),
    hum:        fc.float({ min: 0,   max: 100, noNaN: true }),
    is_running: fc.integer({ min: 0, max: 1 }),
  })
  .chain((full) =>
    // Pick a non-empty subset of fields to remove
    fc
      .subarray(REQUIRED_FIELDS_LIST, { minLength: 1 })
      .map((fieldsToRemove) => {
        const partial = { ...full };
        for (const f of fieldsToRemove) delete partial[f];
        return partial;
      })
  );

/** Arbitrary that produces either a non-JSON string or a JSON with missing fields */
const invalidPayloadArb = fc.oneof(
  nonJsonArb,
  missingFieldPayloadArb.map((obj) => JSON.stringify(obj))
);

describe('Property 4: Invalid payload rejection', () => {
  test(
    'row count is unchanged when payload is non-JSON or missing required fields',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          invalidPayloadArb,
          async (rawMessage) => {
            const dbPath = path.join(
              os.tmpdir(),
              `ems_p4_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
            );

            try {
              const db = await initDb(dbPath);

              // Capture row count before attempting to process the invalid message
              const connBefore = await openRaw(dbPath);
              const countBefore = await new Promise((resolve, reject) =>
                connBefore.get('SELECT COUNT(*) as cnt FROM emission_logs', (err, row) =>
                  err ? reject(err) : resolve(row.cnt)
                )
              );
              await closeRaw(connBefore);

              // Attempt to parse — must return ok: false
              const buffer = Buffer.from(rawMessage, 'utf8');
              const result = parsePayload(buffer);
              expect(result.ok).toBe(false);

              // Do NOT insert — server discards invalid payloads
              await closeDb(db);

              // Row count must be unchanged
              const connAfter = await openRaw(dbPath);
              const countAfter = await new Promise((resolve, reject) =>
                connAfter.get('SELECT COUNT(*) as cnt FROM emission_logs', (err, row) =>
                  err ? reject(err) : resolve(row.cnt)
                )
              );
              await closeRaw(connAfter);

              expect(countAfter).toBe(countBefore);
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

// ---------------------------------------------------------------------------
// Property 5: Boolean is_running rejection
// Feature: vehicle-emissions-monitor, Property 5: Boolean is_running rejection
// For any otherwise-valid Sensor_Payload where is_running is a JavaScript
// boolean (true or false) rather than a numeric integer, the Server SHALL
// reject the payload and the emission_logs row count SHALL remain unchanged.
// Validates: Requirements 4.7
// ---------------------------------------------------------------------------

/** Arbitrary for otherwise-valid payloads with boolean is_running */
const booleanIsRunningArb = fc.record({
  co:         fc.float({ min: 0, max: 1000, noNaN: true }),
  nox:        fc.float({ min: 0, max: 1000, noNaN: true }),
  temp:       fc.float({ min: -40, max: 80,  noNaN: true }),
  hum:        fc.float({ min: 0,   max: 100, noNaN: true }),
  is_running: fc.boolean(),
});

describe('Property 5: Boolean is_running rejection', () => {
  test(
    'row count is unchanged when is_running is a boolean',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          booleanIsRunningArb,
          async (payload) => {
            const dbPath = path.join(
              os.tmpdir(),
              `ems_p5_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
            );

            try {
              const db = await initDb(dbPath);

              const connBefore = await openRaw(dbPath);
              const countBefore = await new Promise((resolve, reject) =>
                connBefore.get('SELECT COUNT(*) as cnt FROM emission_logs', (err, row) =>
                  err ? reject(err) : resolve(row.cnt)
                )
              );
              await closeRaw(connBefore);

              // Parser must reject a boolean is_running
              const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
              const result = parsePayload(buffer);
              expect(result.ok).toBe(false);

              // Do NOT insert — server discards invalid payloads
              await closeDb(db);

              const connAfter = await openRaw(dbPath);
              const countAfter = await new Promise((resolve, reject) =>
                connAfter.get('SELECT COUNT(*) as cnt FROM emission_logs', (err, row) =>
                  err ? reject(err) : resolve(row.cnt)
                )
              );
              await closeRaw(connAfter);

              expect(countAfter).toBe(countBefore);
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
