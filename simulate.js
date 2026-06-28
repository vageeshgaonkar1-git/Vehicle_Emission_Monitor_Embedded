// Vehicle Emissions Monitor — Simulation Script
//
// Publishes mock Sensor_Payloads to the MQTT broker for testing without hardware.
//
// Configurable environment variables (with defaults):
//   MQTT_URL      MQTT broker URL               (default: mqtt://localhost:1883)
//   INTERVAL_MS   Publish interval in ms        (default: 5000)

'use strict';

const mqtt = require('mqtt');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '5000', 10);

const client = mqtt.connect(MQTT_URL);

client.on('connect', () => {
  console.log(`simulate.js connected to ${MQTT_URL}, publishing every ${INTERVAL_MS}ms`);

  setInterval(() => {
    const payload = {
      co: parseFloat((Math.random() * 100).toFixed(2)),
      nox: parseFloat((Math.random() * 50).toFixed(2)),
      temp: parseFloat((20 + Math.random() * 20).toFixed(2)),
      hum: parseFloat((40 + Math.random() * 40).toFixed(2)),
      is_running: Math.random() > 0.5 ? 1 : 0,
      timestamp: new Date().toISOString(),
    };

    client.publish('vehicle/emissions', JSON.stringify(payload), (err) => {
      if (err) {
        console.error('Publish error:', err.message);
      } else {
        console.log('Published:', JSON.stringify(payload));
      }
    });
  }, INTERVAL_MS);
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
  process.exit(1);
});
