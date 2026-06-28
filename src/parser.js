// Payload parser and validator
// Parses incoming MQTT message buffers and validates Sensor_Payload structure.

'use strict';

const REQUIRED_FIELDS = ['co', 'nox', 'temp', 'hum', 'is_running'];

/**
 * Check whether a string is a valid ISO 8601 date.
 * @param {string} str
 * @returns {boolean}
 */
function isValidIso8601(str) {
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime()) && str.trim() !== '';
}

/**
 * Parse and validate an MQTT message buffer as a Sensor_Payload.
 *
 * @param {Buffer|string} buffer - Raw MQTT message
 * @returns {{ ok: boolean, data?: object, error?: string }}
 *
 * On success, data contains:
 *   { timestamp, co_level, nox_level, temperature, humidity, vibration_status }
 */
function parsePayload(buffer) {
  // 1. Parse JSON
  let raw;
  try {
    raw = JSON.parse(buffer.toString('utf8'));
  } catch (e) {
    return { ok: false, error: `Parse error: ${e.message}` };
  }

  // 2. Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in raw)) {
      return { ok: false, error: `Validation error: missing required field "${field}"` };
    }
  }

  // 3. Reject boolean is_running
  if (typeof raw.is_running === 'boolean') {
    return { ok: false, error: 'Validation error: is_running must be a numeric integer (0 or 1), not a boolean' };
  }

  // 4. Resolve timestamp
  const timestamp = isValidIso8601(raw.timestamp)
    ? raw.timestamp
    : new Date().toISOString();

  return {
    ok: true,
    data: {
      timestamp,
      co_level: raw.co,
      nox_level: raw.nox,
      temperature: raw.temp,
      humidity: raw.hum,
      vibration_status: Number(raw.is_running),
    },
  };
}

module.exports = { parsePayload, isValidIso8601 };
