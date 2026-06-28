// Database initialization module
// Configurable via environment variables:
//   DB_PATH (default: emissions.db)

'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'emissions.db');

let db;

/**
 * Initialize the SQLite database and create the emission_logs table if it doesn't exist.
 * @param {string} [dbPath] - Optional path override (used in tests)
 * @returns {Promise<sqlite3.Database>}
 */
function initDb(dbPath) {
  return new Promise((resolve, reject) => {
    const filePath = dbPath || DB_PATH;
    db = new sqlite3.Database(filePath, (err) => {
      if (err) return reject(err);

      db.run(
        `CREATE TABLE IF NOT EXISTS emission_logs (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp        TEXT    NOT NULL,
          co_level         REAL    NOT NULL,
          nox_level        REAL    NOT NULL,
          temperature      REAL    NOT NULL,
          humidity         REAL    NOT NULL,
          vibration_status INTEGER NOT NULL
        )`,
        (err) => {
          if (err) return reject(err);
          resolve(db);
        }
      );
    });
  });
}

/**
 * Insert a validated emission record into emission_logs.
 * @param {object} record - { timestamp, co_level, nox_level, temperature, humidity, vibration_status }
 * @returns {Promise<{id: number, timestamp: string}>}
 */
function insertRecord(record) {
  return new Promise((resolve, reject) => {
    const sql = `INSERT INTO emission_logs
      (timestamp, co_level, nox_level, temperature, humidity, vibration_status)
      VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(
      sql,
      [
        record.timestamp,
        record.co_level,
        record.nox_level,
        record.temperature,
        record.humidity,
        record.vibration_status,
      ],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, timestamp: record.timestamp });
      }
    );
  });
}

/**
 * Query the most recent N rows from emission_logs, ordered newest-first.
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
function queryHistory(limit = 100) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM emission_logs ORDER BY id DESC LIMIT ?`,
      [limit],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

/**
 * Return the current db instance (must call initDb first).
 */
function getDb() {
  return db;
}

module.exports = { initDb, insertRecord, queryHistory, getDb };
