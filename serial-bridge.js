// Vehicle Emissions Monitor — Serial Bridge (ESP32 replacement)
//
// Reads UART_Frames from the STM32 via the Nucleo's virtual COM port and
// publishes each frame as a Sensor_Payload to the MQTT broker.
// This replaces the ESP32 Wi-Fi bridge when the ESP32 is unavailable.
//
// Wiring (no change needed from the original design):
//   STM32 UART2 PA2 (TX) → Nucleo ST-Link virtual COM port → USB → laptop
//   The Nucleo board exposes this as a COM port automatically.
//
// Configurable environment variables (with defaults):
//   SERIAL_PORT   COM port of the Nucleo board   (default: COM3 on Windows)
//   BAUD_RATE     UART baud rate                 (default: 115200)
//   MQTT_URL      MQTT broker URL                (default: mqtt://localhost:1883)
//
// Usage:
//   node serial-bridge.js
//   SERIAL_PORT=COM5 node serial-bridge.js

'use strict';

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const mqtt = require('mqtt');

const SERIAL_PORT = process.env.SERIAL_PORT || 'COM3';
const BAUD_RATE   = parseInt(process.env.BAUD_RATE || '115200', 10);
const MQTT_URL    = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MQTT_TOPIC  = 'vehicle/emissions';

console.log(`[Bridge] Opening serial port ${SERIAL_PORT} at ${BAUD_RATE} baud`);
console.log(`[Bridge] Publishing to MQTT broker at ${MQTT_URL}`);

// ── MQTT client ──────────────────────────────────────────────────────────────
const mqttClient = mqtt.connect(MQTT_URL);

mqttClient.on('connect', () => {
  console.log(`[Bridge] Connected to MQTT broker at ${MQTT_URL}`);
});

mqttClient.on('error', (err) => {
  console.error('[Bridge] MQTT error:', err.message);
  process.exit(1);
});

// ── Serial port ──────────────────────────────────────────────────────────────
const port = new SerialPort({
  path: SERIAL_PORT,
  baudRate: BAUD_RATE,
  autoOpen: false,
});

// ReadlineParser splits the incoming byte stream on '\n' — exactly how the
// STM32 terminates each UART_Frame (Requirement 13.3).
const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

port.open((err) => {
  if (err) {
    console.error(`[Bridge] Failed to open ${SERIAL_PORT}: ${err.message}`);
    console.error('[Bridge] Tip: check Device Manager for the correct COM port number.');
    process.exit(1);
  }
  console.log(`[Bridge] Serial port ${SERIAL_PORT} open`);
});

// ── Frame handler ────────────────────────────────────────────────────────────
parser.on('data', (line) => {
  const frame = line.trim();
  if (!frame) return;

  // Validate JSON before publishing (mirrors ESP32 Requirement 11.4)
  let parsed;
  try {
    parsed = JSON.parse(frame);
  } catch (e) {
    console.error('[Bridge] Invalid JSON frame discarded:', frame);
    return;
  }

  if (!mqttClient.connected) {
    console.warn('[Bridge] MQTT not connected — frame dropped:', frame);
    return;
  }

  mqttClient.publish(MQTT_TOPIC, JSON.stringify(parsed), (pubErr) => {
    if (pubErr) {
      console.error('[Bridge] Publish error:', pubErr.message);
    } else {
      console.log('[Bridge] Published:', JSON.stringify(parsed));
    }
  });
});

port.on('error', (err) => {
  console.error('[Bridge] Serial error:', err.message);
});

port.on('close', () => {
  console.warn('[Bridge] Serial port closed.');
});
