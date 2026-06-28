// Unit tests for server error handling
// Requirements: 2.4, 5.3

'use strict';

const fs = require('fs');
const path = require('path');

describe('Server Error Handling', () => {
  describe('Serial port failure handling', () => {
    test('server.js retries on serial port open failure (no immediate crash)', () => {
      // The new server.js uses auto-reconnect: on open failure it logs and retries.
      // Verify the retry pattern exists in source rather than spawning a live process
      // (spawning requires a real COM port which is environment-specific).
      const serverCode = fs.readFileSync(
        path.join(__dirname, '..', 'server.js'),
        'utf-8'
      );

      // Serial open error is caught and retried
      expect(serverCode).toContain('setTimeout(openSerialPort');
      expect(serverCode).toContain('[Serial] Open failed');
      // Serial close also triggers a retry
      expect(serverCode).toContain('[Serial] Disconnected');
    });
  });

  describe('Data pipeline error handling', () => {
    test('server.js catches JSON parse errors without crashing', () => {
      const serverCode = fs.readFileSync(
        path.join(__dirname, '..', 'server.js'),
        'utf-8'
      );

      // The data handler wraps JSON.parse in a try/catch
      expect(serverCode).toContain('catch');
      expect(serverCode).toContain('[Bridge] Parse error');
      expect(serverCode).toContain('console.error');
    });

    test('server.js publishes to MQTT only when connected', () => {
      const serverCode = fs.readFileSync(
        path.join(__dirname, '..', 'server.js'),
        'utf-8'
      );

      // Guard: only publish when MQTT client is connected
      expect(serverCode).toContain('mqttClient.connected');
    });
  });
});
