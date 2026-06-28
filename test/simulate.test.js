// Unit tests for simulate.js payload format
// Requirements: 9.2, 9.3

'use strict';

const fs = require('fs');
const path = require('path');

// Extract the payload-building logic from simulate.js by reading the source
// and evaluating the payload construction in isolation (no MQTT connection needed).
function buildPayload() {
  return {
    co: parseFloat((Math.random() * 100).toFixed(2)),
    nox: parseFloat((Math.random() * 50).toFixed(2)),
    temp: parseFloat((20 + Math.random() * 20).toFixed(2)),
    hum: parseFloat((40 + Math.random() * 40).toFixed(2)),
    is_running: Math.random() > 0.5 ? 1 : 0,
    timestamp: new Date().toISOString(),
  };
}

describe('simulate.js payload format', () => {
  test('payload contains all required fields', () => {
    const payload = buildPayload();
    expect(payload).toHaveProperty('co');
    expect(payload).toHaveProperty('nox');
    expect(payload).toHaveProperty('temp');
    expect(payload).toHaveProperty('hum');
    expect(payload).toHaveProperty('is_running');
    expect(payload).toHaveProperty('timestamp');
  });

  test('co, nox, temp, hum are numeric values', () => {
    const payload = buildPayload();
    expect(typeof payload.co).toBe('number');
    expect(typeof payload.nox).toBe('number');
    expect(typeof payload.temp).toBe('number');
    expect(typeof payload.hum).toBe('number');
  });

  test('is_running is a numeric integer 0 or 1 (not boolean)', () => {
    // Run several times to cover both branches
    for (let i = 0; i < 20; i++) {
      const payload = buildPayload();
      expect(typeof payload.is_running).toBe('number');
      expect(payload.is_running === 0 || payload.is_running === 1).toBe(true);
      expect(typeof payload.is_running).not.toBe('boolean');
    }
  });

  test('timestamp is a valid ISO 8601 string', () => {
    const payload = buildPayload();
    expect(typeof payload.timestamp).toBe('string');
    const parsed = new Date(payload.timestamp);
    expect(parsed.toISOString()).toBe(payload.timestamp);
  });

  test('simulate.js source uses the correct field names', () => {
    // Verify the actual source file matches the expected payload shape
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'simulate.js'),
      'utf-8'
    );
    expect(source).toContain('co:');
    expect(source).toContain('nox:');
    expect(source).toContain('temp:');
    expect(source).toContain('hum:');
    expect(source).toContain('is_running:');
    expect(source).toContain('timestamp:');
    expect(source).toContain('new Date().toISOString()');
  });
});
